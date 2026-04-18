import type { ChildProcess} from 'child_process';
import { spawn } from 'child_process';
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
    DOWNLOAD_TIMEOUT_MS,
    DOWNLOAD_MAX_RETRIES,
    DOWNLOAD_RETRY_DELAY_MS,
    getDataDir,
} from './constants';
import type { PreferencesStore } from './preferences-store';

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

function fetchJson(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        }, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                clearTimeout(timeout);
                try { resolve(JSON.parse(data)); }
                catch (err) { reject(err); }
            });
        });
        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

function downloadFileOnce(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

        const file = fs.createWriteStream(destPath);
        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        }, (res) => {
            res.pipe(file);
            file.on('finish', () => {
                clearTimeout(timeout);
                file.close(() => resolve());
            });
        });
        req.on('error', (err) => {
            clearTimeout(timeout);
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

async function downloadFile(url: string, destPath: string): Promise<void> {
    for (let attempt = 0; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
        try {
            return await downloadFileOnce(url, destPath);
        } catch (err) {
            if (attempt < DOWNLOAD_MAX_RETRIES) {
                console.warn(`[Server] Download attempt ${attempt + 1} failed, retrying in ${DOWNLOAD_RETRY_DELAY_MS}ms...`);
                await new Promise(r => setTimeout(r, DOWNLOAD_RETRY_DELAY_MS));
            } else {
                throw err;
            }
        }
    }
}

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

    async getLatestVersion(): Promise<string> {
        try {
            const releases = await fetchJson(GITHUB_RELEASES_API);
            return releases[0]?.tag_name ?? '';
        } catch {
            return '';
        }
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
        fs.writeFileSync(versionPath, version, 'utf-8');
    }

    async downloadServer(version: string): Promise<void> {
        const artifactName = this.getArtifactName();
        const downloadUrl = `${GITHUB_RELEASES_DOWNLOAD}/${version}/${artifactName}`;
        const dataDir = getDataDir();
        const zipPath = path.join(dataDir, artifactName);

        this.onLog(`Downloading ECA server ${version} from ${downloadUrl}`);
        await downloadFile(downloadUrl, zipPath);

        this.onLog(`Extracting ${artifactName}...`);
        await extractZip(zipPath, { dir: dataDir });

        // Clean up the zip file
        fs.unlinkSync(zipPath);

        // Set executable permissions on non-Windows (managed binary only;
        // a user-provided custom binary is expected to already be executable).
        if (os.platform() !== 'win32') {
            const binaryPath = this.getManagedBinaryPath();
            fs.chmodSync(binaryPath, 0o775);
        }

        this.writeVersionFile(version);
        this.onLog(`ECA server ${version} installed successfully`);
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
        const latestVersion = await this.getLatestVersion();
        const currentVersion = this.readVersionFile();

        const binaryExists = fs.existsSync(binaryPath);

        if (binaryExists && latestVersion && currentVersion === latestVersion) {
            this.onLog(`ECA server is up to date (${currentVersion})`);
            return binaryPath;
        }

        if (latestVersion) {
            this.onLog(`Updating ECA server: ${currentVersion || 'none'} -> ${latestVersion}`);
            await this.downloadServer(latestVersion);
        } else if (!binaryExists) {
            throw new Error('Cannot download ECA server: failed to fetch latest version');
        } else {
            this.onLog('Could not check for updates, using existing binary');
        }

        return binaryPath;
    }

    async start(workspaceFolders: { name: string; uri: string }[] = []): Promise<void> {
        this.setStatus(EcaServerStatus.Starting);
        // Reset the init-progress tracker for this attempt. Without
        // this, a previous run's finished tasks would be interpreted
        // as "already done" the moment we transition to Initializing.
        this._initTasks.clear();
        this._lastProgressAt = 0;
        this.clearInitTimer();

        try {
            const serverPath = await this.ensureServer();

            this.onLog(`Starting ECA server: ${serverPath}`);
            this._proc = spawn(serverPath, ['server'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this._proc.stderr?.on('data', (data: Buffer) => {
                this.onLog(data.toString().trimEnd());
            });

            this._proc.on('close', (code) => {
                this.onLog(`ECA server process exited with code ${code}`);
                // Treat Initializing identically to Running/Starting for
                // abnormal-exit detection: a process that dies mid-init
                // is a failure, not a clean shutdown.
                if (
                    this._status === EcaServerStatus.Running
                    || this._status === EcaServerStatus.Starting
                    || this._status === EcaServerStatus.Initializing
                ) {
                    this.clearInitTimer();
                    this.setStatus(EcaServerStatus.Failed);
                }
            });

            this._proc.on('error', (err) => {
                this.onLog(`ECA server process error: ${err.message}`);
                this.clearInitTimer();
                this.setStatus(EcaServerStatus.Failed);
            });

            this._connection = rpc.createMessageConnection(
                new rpc.StreamMessageReader(this._proc.stdout!),
                new rpc.StreamMessageWriter(this._proc.stdin!),
            );

            this._connection.listen();

            // Register notification handlers BEFORE any client→server
            // request is sent. The ECA server emits $/progress (and
            // other notifications such as config/updated and
            // tool/serverUpdated) from inside its `initialized`
            // handler, so a handler registered later would miss them —
            // vscode-jsonrpc drops notifications with no handler at
            // the time of arrival (no buffering, no replay).
            this.onConnectionReady(this._connection);

            const initResult = await this._connection.sendRequest('initialize', {
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

            this.onLog(`ECA server initialized: ${JSON.stringify(initResult)}`);
            this._connection.sendNotification('initialized', {});

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
            this.onLog(`Failed to start ECA server: ${message}`);
            this.clearInitTimer();
            this.setStatus(EcaServerStatus.Failed);
            throw err;
        }
    }

    async stop(): Promise<void> {
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
                    await this._connection.sendRequest('shutdown');
                    this._connection.sendNotification('exit');
                } catch {
                    // Connection may already be closed
                }
                this._connection.dispose();
                this._connection = null;
            }
        }

        if (this._proc && !this._proc.killed) {
            this._proc.kill();
            this._proc = null;
        }

        this.setStatus(EcaServerStatus.Stopped);
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }
}
