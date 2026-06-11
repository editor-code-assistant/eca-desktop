import type { ChildProcess} from 'child_process';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import extractZip from 'extract-zip';
import { https } from 'follow-redirects';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as rpc from 'vscode-jsonrpc/node';
import {
    GITHUB_RELEASES_API,
    GITHUB_RELEASES_DOWNLOAD,
    USER_AGENT,
    CLIENT_NAME,
    CLIENT_VERSION,
    PLATFORM_ARTIFACTS,
    HTTP_TIMEOUT_MS,
    HTTP_MAX_RETRIES,
    HTTP_RETRY_DELAY_MS,
    HTTP_RETRY_BACKOFF_FACTOR,
    DOWNLOAD_TIMEOUT_MS,
    DOWNLOAD_MAX_RETRIES,
    DOWNLOAD_RETRY_DELAY_MS,
    DOWNLOAD_RETRY_BACKOFF_FACTOR,
    SERVER_INIT_TIMEOUT_MS,
    SERVER_STOP_GRACE_MS,
    SERVER_RESTART_MAX_ATTEMPTS,
    SERVER_RESTART_BASE_DELAY_MS,
    MIN_SERVER_VERSION,
    getDataDir,
} from './constants';
import type { PreferencesStore } from './preferences-store';
import { resolveShellEnv } from './shell-env';

// ── GitHub release shape (narrow type guard) ──
// Replaces the audit-flagged `releases[0]?.tag_name` access on `unknown`.
interface GitHubRelease {
    tag_name: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
}

function isGitHubRelease(v: unknown): v is GitHubRelease {
    return (
        typeof v === 'object'
        && v !== null
        && typeof (v as { tag_name?: unknown }).tag_name === 'string'
    );
}

function isGitHubReleaseArray(v: unknown): v is GitHubRelease[] {
    return Array.isArray(v) && (v.length === 0 || isGitHubRelease(v[0]));
}

// Compare two semver-ish tags ("0.5.5", "v0.6.0"). Returns negative if a < b,
// zero if equal, positive if a > b. Non-numeric components are ignored.
function compareVersions(a: string, b: string): number {
    const normalize = (s: string): number[] =>
        s.replace(/^v/, '').split(/[.\-+]/).map((p) => {
            const n = parseInt(p, 10);
            return Number.isFinite(n) ? n : 0;
        });
    const aa = normalize(a);
    const bb = normalize(b);
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
        const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export enum EcaServerStatus {
    Stopped = 'Stopped',
    Starting = 'Starting',
    /**
     * Server process is alive, `initialize` has round-tripped, and the
     * client has sent `initialized` — but the server is still running
     * its post-`initialized` async work (sync models, resolve plugins,
     * start MCP servers, cleanup). The ECA server announces these
     * tasks via `$/progress` notifications; see `recordInitProgress`.
     *
     * The bridge still blocks user prompts during this phase (see the
     * drop-gate in src/main/bridge.ts), the webview keeps showing the
     * startup card with the live "N/M · title" progress line
     * (Chat.tsx), and the prompt stays `!enabled` (ChatPrompt.tsx).
     * We transition to `Running` once every known progress task has
     * reached its matching `finish` pair, or after a safety idle
     * timeout for servers that don't emit `$/progress` at all.
     */
    Initializing = 'Initializing',
    Running = 'Running',
    Failed = 'Failed',
}

function fetchJsonOnce(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        }, (res) => {
            // Audit finding S3: a non-2xx status used to produce a
            // JSON-parse error or be treated as legitimate JSON; either
            // way the real HTTP problem was hidden.
            if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
                clearTimeout(timeout);
                res.resume(); // drain to free the socket
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                clearTimeout(timeout);
                try { resolve(JSON.parse(data)); }
                catch (err) { reject(err); }
            });
            res.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// Retrying wrapper around `fetchJsonOnce`. Transient failures (DNS
// hiccups, rate-limit responses, TLS resets, idle-socket aborts) are
// retried with exponential backoff before the error propagates to
// callers like `getLatestVersion`, which previously would dead-end on
// the very first blip.
function fetchJson(url: string): Promise<unknown> {
    return withRetry(
        () => fetchJsonOnce(url),
        {
            maxRetries: HTTP_MAX_RETRIES,
            baseDelayMs: HTTP_RETRY_DELAY_MS,
            backoffFactor: HTTP_RETRY_BACKOFF_FACTOR,
            label: `GET ${url}`,
        },
    );
}

function fetchTextOnce(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        }, (res) => {
            if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
                clearTimeout(timeout);
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                clearTimeout(timeout);
                resolve(data);
            });
            res.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// Retrying wrapper around `fetchTextOnce`. Crucial for the sha256sums
// fetch path: without retries, a single transient blip would silently
// downgrade install to the "skip checksum verification" branch, which
// defeats the supply-chain integrity check entirely.
function fetchText(url: string): Promise<string> {
    return withRetry(
        () => fetchTextOnce(url),
        {
            maxRetries: HTTP_MAX_RETRIES,
            baseDelayMs: HTTP_RETRY_DELAY_MS,
            backoffFactor: HTTP_RETRY_BACKOFF_FACTOR,
            label: `GET ${url}`,
        },
    );
}

function downloadFileOnce(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

        const file = fs.createWriteStream(destPath);
        let settled = false;
        const fail = (err: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try { file.close(); } catch { /* noop */ }
            fs.unlink(destPath, () => { reject(err); });
        };

        // Audit findings S2/C5: HTTP status was unchecked. A 404 / 500 / rate
        // limit body used to be written straight to disk and handed to
        // extract-zip, producing a cryptic error and leaving a poisoned
        // file behind. Stream errors were also unattended.
        file.on('error', (err) => fail(err));

        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        }, (res) => {
            if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
                res.resume();
                fail(new Error(`HTTP ${res.statusCode} downloading ${url}`));
                return;
            }
            res.on('error', (err) => fail(err));
            res.pipe(file);
            file.on('finish', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                file.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
        req.on('error', (err) => fail(err));
    });
}

/**
 * Generic retry+exponential-backoff wrapper. Retries the same operation
 * up to `maxRetries` additional times (so `maxRetries + 1` attempts
 * total) with delay `baseDelayMs * backoffFactor^attempt` between
 * attempts. The error from the final attempt propagates unchanged so
 * callers see the original failure reason.
 *
 * Used for both binary downloads (DOWNLOAD_* constants, 2s base) and
 * small JSON/text fetches (HTTP_* constants, 1s base). No retry
 * classification — every error triggers a retry, matching the existing
 * download policy.
 */
async function withRetry<T>(
    operation: () => Promise<T>,
    opts: {
        maxRetries: number;
        baseDelayMs: number;
        backoffFactor: number;
        label: string;
    },
): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await operation();
        } catch (err) {
            lastErr = err;
            if (attempt < opts.maxRetries) {
                const delay = opts.baseDelayMs *
                    Math.pow(opts.backoffFactor, attempt);
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`[Server] ${opts.label} attempt ${attempt + 1} failed (${message}), retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr instanceof Error
        ? lastErr
        : new Error(`${opts.label} failed after retries`);
}

function downloadFile(url: string, destPath: string): Promise<void> {
    return withRetry(
        () => downloadFileOnce(url, destPath),
        {
            maxRetries: DOWNLOAD_MAX_RETRIES,
            baseDelayMs: DOWNLOAD_RETRY_DELAY_MS,
            backoffFactor: DOWNLOAD_RETRY_BACKOFF_FACTOR,
            label: 'Download',
        },
    );
}

async function sha256OfFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', (err) => reject(err));
    });
}

// Single-flight guard for binary downloads. Every session owns its own
// EcaServer instance, but they all share the managed binary under
// ~/.eca-desktop — two sessions starting at once must never download and
// extract over each other. Keyed by version so concurrent callers for
// the same version await one shared install.
let inflightDownload: { version: string; promise: Promise<void> } | null = null;

export class EcaServer {
    private _proc: ChildProcess | null = null;
    private _connection: rpc.MessageConnection | null = null;
    private _status: EcaServerStatus = EcaServerStatus.Stopped;

    // ── Init-progress tracking ──
    //
    // Map keyed by `taskId` recording the latest `type` observed for
    // that task ('start' | 'finish'). Populated from
    // `recordInitProgress`, which the bridge calls for every
    // $/progress notification arriving on this connection.
    // `maybeTransitionToRunning` consults this map to decide when
    // initialization is complete (no entries in the 'start' state).
    private _initTasks = new Map<string, 'start' | 'finish'>();
    // Safety-net timer scheduled when we enter Initializing. Fires if
    // no $/progress activity is observed for INIT_IDLE_MS so the UI
    // isn't stuck forever against a server that never emits progress
    // (older versions, or a partial/silent failure). Cleared on
    // transitions to Running/Stopped/Failed and re-evaluated on every
    // new progress event.
    private _initTimer: NodeJS.Timeout | null = null;
    // Wall-clock timestamp of the last $/progress event. Reset to 0
    // at the top of every `start()` so the idle-check can distinguish
    // "never received any progress" (== 0) from "received progress
    // but went quiet for a while" (> 0).
    private _lastProgressAt: number = 0;

    // Public callbacks — set by bridge after construction
    onStatusChanged: (status: EcaServerStatus) => void = () => {};
    onLog: (msg: string) => void = (msg) => console.log('[ECA Server]', msg);
    // Invoked exactly once per `start()` call, right after the JSON-RPC
    // connection has been created and `listen()` has been called, but
    // BEFORE `initialize` is sent to the server. This is the only
    // safe window in which to register `$/progress` and other
    // notification handlers: the server emits $/progress from inside
    // its `initialized` handler, and vscode-jsonrpc drops notifications
    // for which no handler is registered at the time they arrive
    // (no buffering, no replay). Callers MUST synchronously register
    // every notification handler they care about inside this callback.
    onConnectionReady: (conn: rpc.MessageConnection) => void = () => {};

    constructor(private preferencesStore?: PreferencesStore) {}

    get connection(): rpc.MessageConnection | null {
        return this._connection;
    }

    get status(): EcaServerStatus {
        return this._status;
    }

    private setStatus(status: EcaServerStatus): void {
        this._status = status;
        this.onStatusChanged(status);
    }

    // ── Init-progress tracking ──

    /**
     * Record an incoming $/progress notification from the server.
     *
     * Called by the bridge (src/main/bridge.ts) for every $/progress
     * payload forwarded to the renderer. In addition to the renderer
     * forwarding, this method updates the local tracker and drives
     * the Initializing → Running transition once every task has
     * reached its matching `finish`.
     *
     * A $/progress arriving in any state other than Initializing is
     * still recorded (so diagnostics stay consistent) but the status
     * machine is a no-op for those — see `maybeTransitionToRunning`.
     */
    recordInitProgress(params: { taskId: string; title: string; type: 'start' | 'finish' }): void {
        this._initTasks.set(params.taskId, params.type);
        this._lastProgressAt = Date.now();
        this.maybeTransitionToRunning();
    }

    /**
     * Promote Initializing → Running when every recorded task has
     * reached its `finish` pair. Guarded by the current status so a
     * late / stray progress event can't re-trigger the transition
     * from Running (or any terminal state).
     */
    private maybeTransitionToRunning(): void {
        if (this._status !== EcaServerStatus.Initializing) return;
        if (this._initTasks.size === 0) return;
        const hasActive = Array.from(this._initTasks.values()).some((t) => t === 'start');
        if (!hasActive) {
            this.clearInitTimer();
            this.setStatus(EcaServerStatus.Running);
        }
    }

    /**
     * Safety-net scheduler. Started when we enter Initializing.
     * Promotes to Running if no $/progress activity has been observed
     * for INIT_IDLE_MS (either no progress ever arrived, or the last
     * event was that long ago) and we're still stuck in Initializing.
     * This unblocks the UI against servers that don't emit $/progress
     * at all (older versions, or partial failures that left some
     * `start` without a matching `finish`).
     */
    private startInitTimer(): void {
        this.clearInitTimer();
        const INIT_IDLE_MS = 30_000;
        const check = (): void => {
            if (this._status !== EcaServerStatus.Initializing) return;
            const sinceLast = this._lastProgressAt === 0
                ? Number.POSITIVE_INFINITY
                : Date.now() - this._lastProgressAt;
            if (sinceLast >= INIT_IDLE_MS) {
                this.onLog(
                    `No $/progress activity for ${INIT_IDLE_MS}ms — transitioning to Running.`,
                );
                this._initTimer = null;
                this.setStatus(EcaServerStatus.Running);
                return;
            }
            // Still within the idle window — re-check once the next
            // potential idle deadline rolls around (plus a small
            // fudge so the check lands just after the boundary).
            this._initTimer = setTimeout(check, INIT_IDLE_MS - sinceLast + 50);
        };
        this._initTimer = setTimeout(check, INIT_IDLE_MS);
    }

    private clearInitTimer(): void {
        if (this._initTimer) {
            clearTimeout(this._initTimer);
            this._initTimer = null;
        }
    }

    getArtifactName(): string {
        const platform = os.platform();
        const arch = os.arch();
        const platformArtifacts = PLATFORM_ARTIFACTS[platform];
        if (!platformArtifacts) {
            throw new Error(`Unsupported platform: ${platform}`);
        }
        const artifact = platformArtifacts[arch];
        if (!artifact) {
            throw new Error(`Unsupported architecture: ${arch} on ${platform}`);
        }
        return artifact;
    }

    /** Path to the binary managed by auto-download (under ~/.eca-desktop/). */
    getManagedBinaryPath(): string {
        const binaryName = os.platform() === 'win32' ? 'eca.exe' : 'eca';
        return path.join(getDataDir(), binaryName);
    }

    /** Custom server binary path from user preferences, if configured. */
    getCustomBinaryPath(): string | undefined {
        const custom = this.preferencesStore?.get().serverBinaryPath?.trim();
        return custom && custom.length > 0 ? custom : undefined;
    }

    /**
     * Effective binary path: returns the user's custom override (if set),
     * otherwise the managed auto-download path.
     */
    getServerBinaryPath(): string {
        return this.getCustomBinaryPath() ?? this.getManagedBinaryPath();
    }

    /**
     * Fetch the latest ECA server release tag.
     *
     * Pre-launch this method returned `''` on any failure, which hid
     * network / rate-limit / offline errors from the caller (audit
     * finding S3). Callers now receive a typed rejection so they can
     * surface actionable messages to the user.
     *
     * The underlying `fetchJson` result is `unknown`; we narrow through
     * `isGitHubReleaseArray` to avoid the implicit-any index that used
     * to slip past TS (audit finding "releases[0]?.tag_name on unknown").
     */
    async getLatestVersion(): Promise<string> {
        const releases = await fetchJson(GITHUB_RELEASES_API);
        if (!isGitHubReleaseArray(releases) || releases.length === 0) {
            throw new Error('No ECA server releases found on GitHub.');
        }
        return releases[0].tag_name;
    }

    async getLatestVersionSafe(): Promise<string> {
        try {
            return await this.getLatestVersion();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onLog(`Could not fetch latest ECA server version: ${message}`);
            return '';
        }
    }

    /**
     * Fetch the expected SHA-256 hex digest for `artifactName` at
     * `version`. Looks for a conventional `sha256sums.txt` asset on the
     * release (lines of the form `<hex>  <filename>`); returns null if
     * the release predates checksum publishing so first-launch doesn't
     * hard-fail against older releases.
     */
    async getExpectedChecksum(version: string, artifactName: string): Promise<string | null> {
        const checksumUrl = `${GITHUB_RELEASES_DOWNLOAD}/${version}/sha256sums.txt`;
        let body: string;
        try {
            body = await fetchText(checksumUrl);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onLog(`No sha256sums.txt found for ${version} (${message}); skipping checksum verification.`);
            return null;
        }
        for (const line of body.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            // Accept both `hex filename` (one or more spaces) and gnu's
            // `hex  filename` (two spaces). Also tolerate a leading `*`
            // on the filename (binary-mode marker).
            const parts = trimmed.split(/\s+/);
            if (parts.length < 2) continue;
            const [hex, ...rest] = parts;
            const filename = rest.join(' ').replace(/^\*/, '');
            if (filename === artifactName) return hex.toLowerCase();
        }
        return null;
    }

    readVersionFile(): string {
        const versionPath = path.join(getDataDir(), 'eca-version');
        try {
            return fs.readFileSync(versionPath, 'utf-8').trim();
        } catch {
            return '';
        }
    }

    writeVersionFile(version: string): void {
        const versionPath = path.join(getDataDir(), 'eca-version');
        // Atomic write (temp file + rename) so a concurrent reader can
        // never observe a partially-written version string.
        const tmpPath = `${versionPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmpPath, version, 'utf-8');
        fs.renameSync(tmpPath, versionPath);
    }

    async downloadServer(version: string): Promise<void> {
        if (inflightDownload?.version === version) {
            this.onLog(`ECA server ${version} download already in progress; waiting for it.`);
            return inflightDownload.promise;
        }
        if (!inflightDownload) {
            this.cleanupStaleStageDirs();
        }
        const promise = this.performDownload(version).finally(() => {
            if (inflightDownload?.promise === promise) {
                inflightDownload = null;
            }
        });
        inflightDownload = { version, promise };
        return promise;
    }

    /** Remove stage dirs left behind by a previous crashed/killed run. */
    private cleanupStaleStageDirs(): void {
        const dataDir = getDataDir();
        try {
            for (const entry of fs.readdirSync(dataDir)) {
                if (entry.startsWith('.eca-download-')) {
                    fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
                }
            }
        } catch { /* best-effort */ }
    }

    /**
     * Download + verify + install the server binary.
     *
     * Everything is staged in a temp directory on the same filesystem and
     * the final install is a single `rename(2)`. The previous
     * implementation extracted the zip directly over the live managed
     * binary; any session still executing that file could crash — macOS
     * in particular SIGKILLs a running process whose backing executable
     * is rewritten (code-signature invalidation), which surfaced as
     * "exited with code null" whenever a new session pulled an update
     * while other sessions were running. A rename only swaps the
     * directory entry, so running processes keep their old inode and are
     * untouched.
     */
    private async performDownload(version: string): Promise<void> {
        const artifactName = this.getArtifactName();
        const downloadUrl = `${GITHUB_RELEASES_DOWNLOAD}/${version}/${artifactName}`;
        const dataDir = getDataDir();
        const stageDir = fs.mkdtempSync(path.join(dataDir, '.eca-download-'));
        const zipPath = path.join(stageDir, artifactName);

        try {
            this.onLog(`Downloading ECA server ${version} from ${downloadUrl}`);
            await downloadFile(downloadUrl, zipPath);

            // Supply-chain integrity: verify the downloaded zip against the
            // checksum published alongside the release. Older releases that
            // predate checksum publication log a warning and proceed; MITM
            // scenarios against TLS are the primary threat and HTTPS alone
            // provides baseline protection there. See audit finding C5.
            const expectedHash = await this.getExpectedChecksum(version, artifactName);
            if (expectedHash) {
                const actualHash = await sha256OfFile(zipPath);
                if (actualHash !== expectedHash) {
                    throw new Error(
                        `Checksum mismatch for ${artifactName}: expected ${expectedHash}, got ${actualHash}. ` +
                        `Refusing to install possibly-tampered binary.`,
                    );
                }
                this.onLog(`Checksum OK for ${artifactName} (${actualHash.slice(0, 12)}...)`);
            } else {
                this.onLog(`Proceeding without checksum verification (release predates sha256sums.txt).`);
            }

            this.onLog(`Extracting ${artifactName}...`);
            await extractZip(zipPath, { dir: stageDir });

            // Verify the expected binary actually extracted (audit: the prior
            // implementation assumed the zip contained a file named exactly
            // `eca` / `eca.exe` at the archive root and would chmod/spawn
            // blindly).
            const binaryName = os.platform() === 'win32' ? 'eca.exe' : 'eca';
            const stagedBinary = path.join(stageDir, binaryName);
            if (!fs.existsSync(stagedBinary)) {
                throw new Error(`Downloaded archive did not contain expected binary: ${binaryName}`);
            }

            // Set executable permissions on non-Windows (managed binary only;
            // a user-provided custom binary is expected to already be executable).
            if (os.platform() !== 'win32') {
                fs.chmodSync(stagedBinary, 0o775);
            }

            const managedBinary = this.getManagedBinaryPath();
            try {
                fs.renameSync(stagedBinary, managedBinary);
            } catch {
                // Windows can refuse to rename over a locked/running exe.
                // Drop the old file first and retry once.
                try { fs.unlinkSync(managedBinary); } catch { /* noop */ }
                fs.renameSync(stagedBinary, managedBinary);
            }

            this.writeVersionFile(version);
            this.onLog(`ECA server ${version} installed successfully`);
        } finally {
            // Removes the zip, extraction leftovers, and (on failure) any
            // tainted artifact so a retry can't pick it up.
            fs.rmSync(stageDir, { recursive: true, force: true });
        }
    }

    async ensureServer(): Promise<string> {
        // When a custom server path is configured, skip auto-download and
        // version checks entirely — just validate the file exists.
        const customPath = this.getCustomBinaryPath();
        if (customPath) {
            if (!fs.existsSync(customPath)) {
                throw new Error(`Custom ECA server binary not found at: ${customPath}`);
            }
            this.onLog(`Using custom ECA server binary: ${customPath}`);
            return customPath;
        }

        const binaryPath = this.getManagedBinaryPath();
        const binaryExists = fs.existsSync(binaryPath);

        // Use the "safe" fetch so a transient network failure falls back
        // to the cached binary instead of blocking launch. We still want
        // hard failures (no binary + offline) to produce an actionable
        // error, which we craft below. (Audit finding S3.)
        const latestVersion = await this.getLatestVersionSafe();
        const currentVersion = this.readVersionFile();

        if (binaryExists && latestVersion && currentVersion === latestVersion) {
            this.onLog(`ECA server is up to date (${currentVersion})`);
            return binaryPath;
        }

        if (latestVersion) {
            this.onLog(`Updating ECA server: ${currentVersion || 'none'} -> ${latestVersion}`);
            await this.downloadServer(latestVersion);
            return binaryPath;
        }

        // latestVersion is '' at this point — network error path.
        if (!binaryExists) {
            throw new Error(
                'Cannot download ECA server: unable to reach GitHub releases. '
                + 'Check your network connection, or set a custom server binary path '
                + 'under Preferences.',
            );
        }
        this.onLog('Could not check for updates, using existing binary');
        return binaryPath;
    }

    /**
     * Set of workspace folders the current session was spawned with.
     * Captured in `start()` so auto-restart can bring the server back
     * with the same folders the caller originally requested.
     */
    private _workspaceFolders: { name: string; uri: string }[] = [];

    /** Prevents auto-restart from firing while a user-initiated stop is in flight. */
    private _intentionalStop = false;

    /** Number of consecutive crashes since the last clean start. */
    private _restartAttempts = 0;

    /**
     * Monotonic lifecycle-ownership token, bumped at the top of every
     * start(). Every continuation of an older start() re-checks it after
     * each await and bails out without touching instance state when it
     * has been superseded. This is what prevents a stale attempt from
     * killing the process/connection of the attempt that replaced it
     * (the root cause of self-inflicted "exited with code null" restart
     * storms: two interleaved restart loops repeatedly SIGKILLing each
     * other's freshly-spawned server).
     */
    private _generation = 0;

    /** Pending auto-restart timer; at most one may exist per instance. */
    private _restartTimer: NodeJS.Timeout | null = null;

    async start(workspaceFolders: { name: string; uri: string }[] = []): Promise<void> {
        // Take lifecycle ownership. Any older start() still parked at an
        // await observes the bump at its next checkpoint and bails out
        // WITHOUT touching instance state — a stale attempt must never
        // kill the current attempt's process or dispose its connection.
        const gen = ++this._generation;
        const checkpoint = (): void => {
            if (gen !== this._generation) {
                throw new Error('start attempt superseded by a newer start()');
            }
        };
        this._workspaceFolders = workspaceFolders;
        // A queued auto-restart is redundant now that a start is running.
        this.clearRestartTimer();
        // Reap a leftover process from a previous run. The close handler
        // nulls _proc on exit, so one that is still here AND still alive
        // (no exit code, no signal, no kill sent) is genuinely orphaned.
        if (this._proc && !this._proc.killed
            && this._proc.exitCode === null && this._proc.signalCode === null) {
            this.onLog('Cleaning up orphaned ECA server process before restart.');
            try { this._proc.kill('SIGKILL'); } catch { /* noop */ }
        }
        this._proc = null;
        if (this._connection) {
            try { this._connection.dispose(); } catch { /* noop */ }
            this._connection = null;
        }
        this._intentionalStop = false;
        this.setStatus(EcaServerStatus.Starting);
        // Reset the init-progress tracker for this attempt. Without
        // this, a previous run's finished tasks would be interpreted
        // as "already done" the moment we transition to Initializing.
        this._initTasks.clear();
        this._lastProgressAt = 0;
        this.clearInitTimer();

        // Attempt-local resources. The failure/cleanup paths below must
        // only ever touch these — never whatever the instance fields
        // currently point at, which may already belong to a newer attempt.
        let proc: ChildProcess | null = null;
        let connection: rpc.MessageConnection | null = null;

        try {
            const serverPath = await this.ensureServer();
            checkpoint();

            // M-6 race fix: a user-initiated stop() could have landed while
            // ensureServer() was awaiting (e.g. a slow first-run download).
            // If so, honor the intent and don't spawn. Without this check
            // we'd start a new process that the earlier stop() will never
            // see (stop() already ran, kill was a no-op on null _proc).
            if (this._intentionalStop) {
                this.onLog('Start aborted — stop() was called during ensureServer().');
                this.setStatus(EcaServerStatus.Stopped);
                return;
            }

            // Resolve the user's shell environment (PATH, HOMEBREW_PREFIX,
            // NVM_DIR, ...) before spawning. On macOS / Linux a GUI-launched
            // Electron inherits launchctl's truncated PATH (no homebrew,
            // asdf, nvm, ...), which leaves the ECA server unable to find
            // most tools the user installed. `resolveShellEnv` is cached
            // (warmed up at app start) and returns `{}` on Windows or on
            // any failure — never blocks startup.
            const prefs = this.preferencesStore?.get();
            const shellEnv = await resolveShellEnv({
                enabled: prefs?.resolveShellEnv !== false,
                timeoutMs: prefs?.shellEnvResolutionTimeoutMs,
                onLog: this.onLog,
            });
            checkpoint();
            // Same race as M-6 above, for the shell-env await window.
            if (this._intentionalStop) {
                this.onLog('Start aborted — stop() was called while resolving the shell environment.');
                this.setStatus(EcaServerStatus.Stopped);
                return;
            }

            this.onLog(`Starting ECA server: ${serverPath}`);
            const child = spawn(serverPath, ['server'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ...shellEnv },
            });
            proc = child;
            this._proc = child;

            child.stderr?.on('data', (data: Buffer) => {
                this.onLog(data.toString().trimEnd());
            });

            // Rejects while `initialize` is in flight if the process dies
            // or fails to spawn, so startup fails fast with the real cause
            // (exit code + signal) instead of hanging for the full 30s
            // timeout or surfacing a cryptic "connection got disposed".
            const spawnFailure = new Promise<never>((_, reject) => {
                child.once('close', (code, signal) => reject(new Error(
                    `ECA server process exited during startup (code ${code}, signal ${signal ?? 'none'})`,
                )));
                child.once('error', (err) => reject(new Error(
                    `ECA server process error during startup: ${err.message}`,
                )));
            });

            child.on('close', (code, signal) => {
                // Identity guard: a late exit from a process that is no
                // longer the current one (killed by stop(), or replaced by
                // a newer start) must not touch current state. It used to
                // flip status to Failed and spawn a second, concurrent
                // restart loop.
                if (this._proc !== child) {
                    this.onLog(`Detached ECA server process exited (code ${code}, signal ${signal ?? 'none'}).`);
                    return;
                }
                this._proc = null;
                this.onLog(`ECA server process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
                if (this._status === EcaServerStatus.Starting) {
                    // start() is still in flight for this process; its
                    // `spawnFailure` race rejects and the catch block owns
                    // failure handling + restart scheduling.
                    return;
                }
                // Treat Initializing identically to Running for
                // abnormal-exit detection: a process that dies mid-init
                // is a failure, not a clean shutdown.
                if (this._status === EcaServerStatus.Running
                    || this._status === EcaServerStatus.Initializing) {
                    this.clearInitTimer();
                    this.setStatus(EcaServerStatus.Failed);
                    // Only auto-restart on unexpected exits. `stop()` sets
                    // _intentionalStop before invoking kill, so a clean
                    // user-initiated shutdown won't trigger reconnect.
                    if (!this._intentionalStop) {
                        this.scheduleAutoRestart();
                    }
                }
            });

            child.on('error', (err) => {
                if (this._proc !== child) return;
                this.onLog(`ECA server process error: ${err.message}`);
                if (this._status === EcaServerStatus.Starting) {
                    return; // handled via `spawnFailure` in start()
                }
                this.clearInitTimer();
                this.setStatus(EcaServerStatus.Failed);
                if (!this._intentionalStop) {
                    this.scheduleAutoRestart();
                }
            });

            const conn = rpc.createMessageConnection(
                new rpc.StreamMessageReader(child.stdout!),
                new rpc.StreamMessageWriter(child.stdin!),
            );
            connection = conn;
            this._connection = conn;

            conn.listen();

            // Register notification handlers BEFORE any client→server
            // request is sent. The ECA server emits $/progress (and
            // other notifications such as config/updated and
            // tool/serverUpdated) from inside its `initialized`
            // handler, so a handler registered later would miss them —
            // vscode-jsonrpc drops notifications with no handler at
            // the time of arrival (no buffering, no replay).
            this.onConnectionReady(conn);

            // Hard timeout around `initialize` — a server that writes
            // garbage to stdout (e.g. a stack trace instead of JSON-RPC)
            // used to hang this promise forever. See audit finding S8.
            const initPromise = conn.sendRequest('initialize', {
                processId: process.pid,
                clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
                capabilities: {
                    codeAssistant: {
                        chat: true,
                        chatCapabilities: { askQuestion: true },
                    },
                },
                workspaceFolders,
            });
            let initTimer: NodeJS.Timeout | undefined;
            let initResult: unknown;
            try {
                initResult = await Promise.race([
                    initPromise,
                    spawnFailure,
                    new Promise<never>((_, reject) => {
                        initTimer = setTimeout(
                            () => reject(new Error(`ECA server did not respond to 'initialize' within ${SERVER_INIT_TIMEOUT_MS}ms`)),
                            SERVER_INIT_TIMEOUT_MS,
                        );
                    }),
                ]);
            } finally {
                if (initTimer) clearTimeout(initTimer);
            }
            checkpoint();

            this.onLog(`ECA server initialized: ${JSON.stringify(initResult)}`);

            // Version-compatibility check (audit finding S9). Non-fatal
            // today — a mismatch only warns — but gives users an early
            // signal when a breaking protocol change lands upstream.
            try {
                const serverVersion = (initResult as { serverInfo?: { version?: string } })
                    ?.serverInfo?.version;
                if (serverVersion && compareVersions(serverVersion, MIN_SERVER_VERSION) < 0) {
                    this.onLog(
                        `WARNING: ECA server ${serverVersion} is older than the recommended minimum ${MIN_SERVER_VERSION}. `
                        + `Some features may not work as expected.`,
                    );
                }
            } catch { /* version parsing best-effort */ }

            conn.sendNotification('initialized', {});

            // At this point `initialize` has succeeded — reset the
            // restart counter so a later unrelated crash doesn't hit
            // the attempt ceiling from a previous bad start.
            this._restartAttempts = 0;

            // Fast-path: if progress events already arrived between
            // onConnectionReady and here and every recorded task has
            // reached 'finish' (e.g. a warm-cache server finished its
            // post-`initialized` work synchronously), skip the
            // Initializing phase entirely to avoid a one-frame
            // Initializing → Running flash in the UI.
            const fastDone =
                this._initTasks.size > 0
                && Array.from(this._initTasks.values()).every((t) => t === 'finish');
            if (fastDone) {
                this.setStatus(EcaServerStatus.Running);
            } else {
                this.setStatus(EcaServerStatus.Initializing);
                this.startInitTimer();
                // A progress event may have arrived while we were in
                // Starting state — re-check now that we're actually
                // in Initializing so a finished-before-we-got-here
                // tracker still transitions us to Running.
                this.maybeTransitionToRunning();
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // H-1 fix: when `initialize` times out (or any other post-spawn
            // failure in this try block), the spawned `eca` child is still
            // alive holding stdio pipes open. Without an explicit kill,
            // (a) we leak a zombie process until app quit, and (b) neither
            // the `close` nor `error` handlers will fire to schedule
            // auto-restart (the process didn't exit).
            //
            // Crucially we tear down THIS attempt's resources only (the
            // locals), never the instance fields: those may already belong
            // to a newer attempt, and disposing/killing through them is
            // exactly how a stale catch used to murder its successor's
            // healthy process.
            if (connection) {
                try { connection.dispose(); } catch { /* noop */ }
                if (this._connection === connection) {
                    this._connection = null;
                }
            }
            if (proc) {
                if (proc.exitCode === null && proc.signalCode === null) {
                    try { proc.kill('SIGTERM'); } catch { /* noop */ }
                    // SIGKILL follow-up after a short beat so a wedged
                    // server doesn't linger. (Checked via exitCode /
                    // signalCode, not `killed` — `killed` flips true the
                    // moment WE send SIGTERM, which made this escalation a
                    // permanent no-op before.)
                    const p = proc;
                    setTimeout(() => {
                        try {
                            if (p.exitCode === null && p.signalCode === null) {
                                p.kill('SIGKILL');
                            }
                        } catch { /* noop */ }
                    }, SERVER_STOP_GRACE_MS);
                }
                if (this._proc === proc) {
                    this._proc = null;
                }
            }

            if (gen !== this._generation) {
                // Superseded: a newer start()/stop() owns the lifecycle
                // now. Don't touch status, don't schedule restarts, don't
                // propagate the failure.
                this.onLog(`Stale ECA server start attempt ended: ${message}`);
                return;
            }

            this.onLog(`Failed to start ECA server: ${message}`);
            this.clearInitTimer();

            if (this._intentionalStop) {
                // stop() raced this start and owns the final status.
                return;
            }

            this.setStatus(EcaServerStatus.Failed);
            this.scheduleAutoRestart();

            throw err;
        }
    }

    /**
     * Auto-restart on unexpected crash. Bounded by
     * SERVER_RESTART_MAX_ATTEMPTS with exponential backoff so a
     * persistently-broken binary doesn't spin-loop.
     */
    private scheduleAutoRestart(): void {
        // Idempotent: one crash fans out into several failure signals
        // (process close, connection dispose, initialize rejection); they
        // must coalesce into a single pending restart, never parallel
        // restart loops.
        if (this._restartTimer) return;
        if (this._restartAttempts >= SERVER_RESTART_MAX_ATTEMPTS) {
            this.onLog(
                `ECA server failed ${this._restartAttempts} times in a row; giving up. `
                + `Use the restart button to try again.`,
            );
            return;
        }
        this._restartAttempts += 1;
        const delay = SERVER_RESTART_BASE_DELAY_MS *
            Math.pow(2, this._restartAttempts - 1);
        this.onLog(
            `Auto-restarting ECA server in ${delay}ms (attempt ${this._restartAttempts}/${SERVER_RESTART_MAX_ATTEMPTS})...`,
        );
        this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            // Bail if somebody called `stop()` while we were waiting.
            if (this._intentionalStop) return;
            if (this._status === EcaServerStatus.Running
                || this._status === EcaServerStatus.Starting
                || this._status === EcaServerStatus.Initializing) {
                return; // already recovering via some other path
            }
            this.start(this._workspaceFolders).catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.onLog(`Auto-restart failed: ${message}`);
            });
        }, delay);
    }

    private clearRestartTimer(): void {
        if (this._restartTimer) {
            clearTimeout(this._restartTimer);
            this._restartTimer = null;
        }
    }

    async stop(): Promise<void> {
        // Mark the stop as user-initiated so the `close` handler skips
        // auto-restart. Must be set BEFORE we dispose the connection /
        // kill the process to avoid a race with the close event.
        this._intentionalStop = true;

        // Stopping must win over any queued recovery attempt.
        this.clearRestartTimer();

        // Always clear the safety timer — even if the process was
        // already down we don't want an outstanding timeout firing
        // after `stop()` and flipping status back to Running on a
        // freshly-started session (timer ids are per-instance).
        this.clearInitTimer();
        if (
            this._status === EcaServerStatus.Running
            || this._status === EcaServerStatus.Starting
            || this._status === EcaServerStatus.Initializing
        ) {
            if (this._connection) {
                try {
                    // Bound the shutdown round-trip so a wedged server
                    // can't block app quit forever.
                    await Promise.race([
                        (async () => {
                            await this._connection!.sendRequest('shutdown');
                            this._connection!.sendNotification('exit');
                        })(),
                        new Promise((resolve) => setTimeout(resolve, SERVER_STOP_GRACE_MS)),
                    ]);
                } catch {
                    // Connection may already be closed
                }
                try { this._connection.dispose(); } catch { /* noop */ }
                this._connection = null;
            }
        }

        // Send SIGTERM then escalate to SIGKILL if the process doesn't
        // exit within the grace window (audit finding S5).
        if (this._proc && !this._proc.killed) {
            const proc = this._proc;
            this._proc = null;
            await new Promise<void>((resolve) => {
                let settled = false;
                const onExit = (): void => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(killTimer);
                    resolve();
                };
                proc.once('exit', onExit);
                const killTimer = setTimeout(() => {
                    if (settled) return;
                    this.onLog('ECA server did not exit within grace period; sending SIGKILL.');
                    try { proc.kill('SIGKILL'); } catch { /* noop */ }
                    // Give the kernel a beat to reap; resolve either way.
                    setTimeout(onExit, 250);
                }, SERVER_STOP_GRACE_MS);
                try { proc.kill('SIGTERM'); }
                catch { onExit(); }
            });
        }

        this.setStatus(EcaServerStatus.Stopped);
    }

    async restart(): Promise<void> {
        await this.stop();
        // Clear the attempt counter so a user-triggered restart is not
        // held hostage by a previous bad auto-restart streak.
        this._restartAttempts = 0;
        await this.start(this._workspaceFolders);
    }
}
