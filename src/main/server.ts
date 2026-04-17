import { ChildProcess, spawn } from 'child_process';
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
import { PreferencesStore } from './preferences-store';

export enum EcaServerStatus {
    Stopped = 'Stopped',
    Starting = 'Starting',
    Running = 'Running',
    Failed = 'Failed',
}

function fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

        const req = https.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal as any,
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
            signal: controller.signal as any,
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

    // Public callbacks — set by bridge after construction
    onStatusChanged: (status: EcaServerStatus) => void = () => {};
    onLog: (msg: string) => void = (msg) => console.log('[ECA Server]', msg);

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
                if (this._status === EcaServerStatus.Running || this._status === EcaServerStatus.Starting) {
                    this.setStatus(EcaServerStatus.Failed);
                }
            });

            this._proc.on('error', (err) => {
                this.onLog(`ECA server process error: ${err.message}`);
                this.setStatus(EcaServerStatus.Failed);
            });

            this._connection = rpc.createMessageConnection(
                new rpc.StreamMessageReader(this._proc.stdout!),
                new rpc.StreamMessageWriter(this._proc.stdin!),
            );

            this._connection.listen();

            const initResult = await this._connection.sendRequest('initialize', {
                processId: process.pid,
                clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
                capabilities: {
                    codeAssistant: { chat: true },
                    chatCapabilities: { askQuestion: true },
                },
                workspaceFolders,
            });

            this.onLog(`ECA server initialized: ${JSON.stringify(initResult)}`);
            this._connection.sendNotification('initialized', {});
            this.setStatus(EcaServerStatus.Running);
        } catch (err: any) {
            this.onLog(`Failed to start ECA server: ${err.message}`);
            this.setStatus(EcaServerStatus.Failed);
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (this._status === EcaServerStatus.Running || this._status === EcaServerStatus.Starting) {
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
