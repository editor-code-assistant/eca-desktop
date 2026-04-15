import { ChildProcess, spawn } from 'child_process';
import extractZip from 'extract-zip';
import { https } from 'follow-redirects';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as rpc from 'vscode-jsonrpc/node';

export enum EcaServerStatus {
    Stopped = 'Stopped',
    Starting = 'Starting',
    Running = 'Running',
    Failed = 'Failed',
}

const artifacts: Record<string, Record<string, string>> = {
    darwin: {
        x64: 'eca-native-macos-amd64.zip',
        arm64: 'eca-native-macos-aarch64.zip',
    },
    linux: {
        x64: 'eca-native-static-linux-amd64.zip',
        arm64: 'eca-native-linux-aarch64.zip',
    },
    win32: {
        x64: 'eca-native-windows-amd64.zip',
    },
};

function getDataDir(): string {
    const dir = path.join(os.homedir(), '.eca-desktop');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'eca-desktop' } }, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, { headers: { 'User-Agent': 'eca-desktop' } }, (res) => {
            res.pipe(file);
            file.on('finish', () => {
                file.close(() => resolve());
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {}); // Clean up partial file
            reject(err);
        });
    });
}

export class EcaServer {
    private _proc: ChildProcess | null = null;
    private _connection: rpc.MessageConnection | null = null;
    private _status: EcaServerStatus = EcaServerStatus.Stopped;

    // Public callbacks — set by bridge after construction
    onStatusChanged: (status: EcaServerStatus) => void = () => {};
    onLog: (msg: string) => void = (msg) => console.log('[ECA Server]', msg);

    constructor() {}

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
        const platformArtifacts = artifacts[platform];
        if (!platformArtifacts) {
            throw new Error(`Unsupported platform: ${platform}`);
        }
        const artifact = platformArtifacts[arch];
        if (!artifact) {
            throw new Error(`Unsupported architecture: ${arch} on ${platform}`);
        }
        return artifact;
    }

    getServerBinaryPath(): string {
        const binaryName = os.platform() === 'win32' ? 'eca.exe' : 'eca';
        return path.join(getDataDir(), binaryName);
    }

    async getLatestVersion(): Promise<string> {
        try {
            const releases = await fetchJson('https://api.github.com/repos/editor-code-assistant/eca/releases');
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
        const downloadUrl = `https://github.com/editor-code-assistant/eca/releases/download/${version}/${artifactName}`;
        const dataDir = getDataDir();
        const zipPath = path.join(dataDir, artifactName);

        this.onLog(`Downloading ECA server ${version} from ${downloadUrl}`);
        await downloadFile(downloadUrl, zipPath);

        this.onLog(`Extracting ${artifactName}...`);
        await extractZip(zipPath, { dir: dataDir });

        // Clean up the zip file
        fs.unlinkSync(zipPath);

        // Set executable permissions on non-Windows
        if (os.platform() !== 'win32') {
            const binaryPath = this.getServerBinaryPath();
            fs.chmodSync(binaryPath, 0o775);
        }

        this.writeVersionFile(version);
        this.onLog(`ECA server ${version} installed successfully`);
    }

    async ensureServer(): Promise<string> {
        const binaryPath = this.getServerBinaryPath();
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
                clientInfo: { name: 'Desktop', version: '0.1.0' },
                capabilities: {
                    codeAssistant: { chat: true },
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
