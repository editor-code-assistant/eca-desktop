import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { zipSync } from 'fflate';
import * as os from 'os';

// ── Mocks ──
//
// Mock `os` so we can vary platform/arch per test without touching the
// real host. Spread the real module so things like homedir() still work
// (constants.ts and fs helpers rely on them).
const osMock = vi.hoisted(() => ({
    platform: vi.fn(() => 'linux' as NodeJS.Platform),
    arch: vi.fn(() => 'x64' as string),
    home: '',
}));
vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof os>();
    return {
        ...actual,
        platform: (...args: unknown[]) => osMock.platform(...(args as [])),
        arch: (...args: unknown[]) => osMock.arch(...(args as [])),
        homedir: () => osMock.home || actual.homedir(),
        default: {
            ...actual,
            platform: () => osMock.platform(),
            arch: () => osMock.arch(),
            homedir: () => osMock.home || actual.homedir(),
        },
    };
});

// Mock follow-redirects. Each test configures the next https.get call
// via the mockHttpsGet.mockImplementationOnce shim below.
const mockHttpsGet = vi.hoisted(() => vi.fn());
vi.mock('follow-redirects', () => ({
    https: {
        get: (
            url: string,
            opts: unknown,
            cb?: (res: unknown) => void,
        ) => mockHttpsGet(url, opts, cb),
    },
}));

// Mock electron for any transitive imports.
vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
    app: { getPath: () => '/tmp' },
}));

import { EcaServer, EcaServerStatus } from '../server';
import { HTTP_MAX_RETRIES } from '../constants';

// ── Helpers ──

interface HttpsResponseOpts {
    statusCode?: number;
    body?: string | object | Buffer;
    requestError?: Error;
}

// Shared mock implementation factory used by both the one-shot and the
// persistent configure helpers.
function makeHttpsImpl(opts: HttpsResponseOpts) {
    const { statusCode = 200, body = '', requestError } = opts;
    return (
        _url: string,
        options: unknown,
        callback?: (res: unknown) => void,
    ): EventEmitter => {
        // follow-redirects supports both (url, cb) and (url, opts, cb)
        const cb = typeof options === 'function'
            ? (options as (res: unknown) => void)
            : callback!;
        const req = new EventEmitter() as EventEmitter & {
            on: EventEmitter['on'];
        };
        process.nextTick(() => {
            if (requestError) {
                req.emit('error', requestError);
                return;
            }
            const payload = Buffer.isBuffer(body)
                ? body
                : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
            const res = Object.assign(Readable.from([payload]), { statusCode });
            cb(res);
            if (statusCode < 200 || statusCode >= 300) {
                res.resume();
            }
        });
        return req;
    };
}

function configureHttpsOnce(opts: HttpsResponseOpts = {}): void {
    mockHttpsGet.mockImplementationOnce(makeHttpsImpl(opts));
}

// Persistent counterpart for tests that need every call to behave the
// same way (e.g. retry-exhaustion paths where the call is repeated
// HTTP_MAX_RETRIES + 1 times with the same outcome).
function configureHttpsAlways(opts: HttpsResponseOpts = {}): void {
    mockHttpsGet.mockImplementation(makeHttpsImpl(opts));
}

// Helper for tests that exercise the retry loop: prevents the unhandled-
// rejection lint while draining fake timers between attempts.
async function awaitWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
    // Attach a no-op catch BEFORE we yield to the timer driver so a
    // rejection during runAllTimersAsync doesn't surface as unhandled.
    promise.catch(() => undefined);
    await vi.runAllTimersAsync();
    return promise;
}

// ── Tests ──

describe('EcaServer', () => {
    beforeEach(() => {
        mockHttpsGet.mockReset();
        osMock.platform.mockReturnValue('linux');
        osMock.arch.mockReturnValue('x64');
        osMock.home = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-server-test-'));
    });

    afterEach(() => {
        vi.useRealTimers();
        fs.rmSync(osMock.home, { recursive: true, force: true });
        osMock.home = '';
    });

    describe('initial state', () => {
        it('starts in the Stopped status', () => {
            const s = new EcaServer();
            expect(s.status).toBe(EcaServerStatus.Stopped);
            expect(s.connection).toBeNull();
        });
    });

    describe('getArtifactName', () => {
        const cases: Array<[NodeJS.Platform, string, string]> = [
            ['darwin', 'x64', 'eca-native-macos-amd64.zip'],
            ['darwin', 'arm64', 'eca-native-macos-aarch64.zip'],
            ['linux', 'x64', 'eca-native-static-linux-amd64.zip'],
            ['linux', 'arm64', 'eca-native-linux-aarch64.zip'],
            ['win32', 'x64', 'eca-native-windows-amd64.zip'],
        ];

        for (const [platform, arch, expected] of cases) {
            it(`returns ${expected} for ${platform}-${arch}`, () => {
                osMock.platform.mockReturnValue(platform);
                osMock.arch.mockReturnValue(arch);
                const s = new EcaServer();
                expect(s.getArtifactName()).toBe(expected);
            });
        }

        it('throws on unsupported platform', () => {
            osMock.platform.mockReturnValue('freebsd');
            osMock.arch.mockReturnValue('x64');
            const s = new EcaServer();
            expect(() => s.getArtifactName()).toThrow(/Unsupported platform/);
        });

        it('throws on unsupported architecture', () => {
            osMock.platform.mockReturnValue('linux');
            osMock.arch.mockReturnValue('mips');
            const s = new EcaServer();
            expect(() => s.getArtifactName()).toThrow(/Unsupported architecture/);
        });

        it('throws on win32-arm64 (not published)', () => {
            osMock.platform.mockReturnValue('win32');
            osMock.arch.mockReturnValue('arm64');
            const s = new EcaServer();
            expect(() => s.getArtifactName()).toThrow(/Unsupported architecture/);
        });
    });

    describe('getLatestVersion', () => {
        it('returns tag_name of the first release', async () => {
            configureHttpsOnce({
                body: [
                    { tag_name: '0.6.0', assets: [] },
                    { tag_name: '0.5.5' },
                ],
            });
            const s = new EcaServer();
            await expect(s.getLatestVersion()).resolves.toBe('0.6.0');
        });

        it('throws when the API returns an empty array', async () => {
            configureHttpsOnce({ body: [] });
            const s = new EcaServer();
            await expect(s.getLatestVersion()).rejects.toThrow(/No ECA server releases/);
        });

        it('throws when the API returns a non-array', async () => {
            configureHttpsOnce({ body: { message: 'rate limited' } });
            const s = new EcaServer();
            await expect(s.getLatestVersion()).rejects.toThrow(/No ECA server releases/);
        });

        it('throws when the first entry is not a GitHub release shape', async () => {
            configureHttpsOnce({ body: [{ foo: 'bar' }] });
            const s = new EcaServer();
            await expect(s.getLatestVersion()).rejects.toThrow(/No ECA server releases/);
        });

        it('rejects on HTTP error status after exhausting retries', async () => {
            vi.useFakeTimers();
            configureHttpsAlways({ statusCode: 403, body: 'rate limited' });
            const s = new EcaServer();
            const promise = s.getLatestVersion();
            await expect(awaitWithFakeTimers(promise)).rejects.toThrow(/HTTP 403/);
            // 1 initial attempt + HTTP_MAX_RETRIES retries.
            expect(mockHttpsGet).toHaveBeenCalledTimes(HTTP_MAX_RETRIES + 1);
        });

        it('rejects on request error after exhausting retries', async () => {
            vi.useFakeTimers();
            configureHttpsAlways({ requestError: new Error('ECONNRESET') });
            const s = new EcaServer();
            const promise = s.getLatestVersion();
            await expect(awaitWithFakeTimers(promise)).rejects.toThrow(/ECONNRESET/);
            expect(mockHttpsGet).toHaveBeenCalledTimes(HTTP_MAX_RETRIES + 1);
        });

        it('retries on transient failure and eventually succeeds', async () => {
            vi.useFakeTimers();
            // First two attempts fail, third succeeds.
            configureHttpsOnce({ requestError: new Error('ECONNRESET') });
            configureHttpsOnce({ statusCode: 503, body: 'service unavailable' });
            configureHttpsOnce({ body: [{ tag_name: 'v0.6.0' }] });
            const s = new EcaServer();
            const promise = s.getLatestVersion();
            await vi.runAllTimersAsync();
            await expect(promise).resolves.toBe('v0.6.0');
            expect(mockHttpsGet).toHaveBeenCalledTimes(3);
        });
    });

    describe('getLatestVersionSafe', () => {
        it('returns empty string after exhausting retries and logs the reason', async () => {
            vi.useFakeTimers();
            configureHttpsAlways({ statusCode: 500, body: '' });
            const s = new EcaServer();
            const logs: string[] = [];
            s.onLog = (msg): void => { logs.push(msg); };
            const promise = s.getLatestVersionSafe();
            await expect(awaitWithFakeTimers(promise)).resolves.toBe('');
            expect(logs.some((m) => /Could not fetch/i.test(m))).toBe(true);
            expect(mockHttpsGet).toHaveBeenCalledTimes(HTTP_MAX_RETRIES + 1);
        });

        it('returns tag_name on success', async () => {
            configureHttpsOnce({ body: [{ tag_name: 'v1.2.3' }] });
            const s = new EcaServer();
            await expect(s.getLatestVersionSafe()).resolves.toBe('v1.2.3');
        });
    });

    describe('getExpectedChecksum', () => {
        const artifact = 'eca-native-static-linux-amd64.zip';
        const hex64 = 'cafebabe'.repeat(8); // 64 hex chars

        it('returns the digest from the per-artifact .sha256 asset', async () => {
            configureHttpsOnce({ body: `${hex64.toUpperCase()}\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe(hex64);
        });

        it('accepts `hex  filename` when it names the requested artifact', async () => {
            configureHttpsOnce({ body: `${hex64}  ${artifact}\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe(hex64);
        });

        it('rejects a malformed digest', async () => {
            configureHttpsOnce({ body: `abc123  ${artifact}\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .rejects.toThrow(/Invalid SHA-256 checksum/);
        });

        it('rejects a checksum that names a different artifact', async () => {
            configureHttpsOnce({ body: `${hex64}  another-artifact.zip\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .rejects.toThrow(/declared a different artifact/);
        });

        it('accepts the GNU binary-mode filename marker', async () => {
            configureHttpsOnce({ body: `${hex64}  *${artifact}\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe(hex64);
        });

        it('fails closed after exhausting retries when the checksum is unavailable', async () => {
            vi.useFakeTimers();
            configureHttpsAlways({ statusCode: 404 });
            const s = new EcaServer();
            const promise = s.getExpectedChecksum('v0.6.0', artifact);
            await expect(awaitWithFakeTimers(promise)).rejects.toThrow(/Could not retrieve checksum/);
            expect(mockHttpsGet).toHaveBeenCalledTimes(HTTP_MAX_RETRIES + 1);
        });

        it('retries the artifact checksum fetch on transient failure and succeeds', async () => {
            vi.useFakeTimers();
            // First attempt blips, second returns the digest.
            configureHttpsOnce({ requestError: new Error('ETIMEDOUT') });
            configureHttpsOnce({ body: `${hex64}\n` });
            const s = new EcaServer();
            const promise = s.getExpectedChecksum('v0.6.0', artifact);
            await vi.runAllTimersAsync();
            await expect(promise).resolves.toBe(hex64);
            expect(mockHttpsGet).toHaveBeenCalledTimes(2);
        });

    });

    describe.runIf(process.platform === 'win32')('Windows backend provisioning integration', () => {
        const version = 'v-test-windows';
        const artifact = 'eca-native-windows-amd64.zip';

        function getWindowsSourceExecutable(): string {
            const windowsRoot = process.env.SystemRoot;
            if (!windowsRoot) throw new Error('SystemRoot is required for the Windows integration test.');
            return path.join(windowsRoot, 'System32', 'where.exe');
        }

        function makeWindowsArchive(entryName = 'eca.exe'): Buffer {
            const sourceExecutable = fs.readFileSync(getWindowsSourceExecutable());
            return Buffer.from(zipSync({ [entryName]: sourceExecutable }, { level: 0 }));
        }

        it('selects, verifies, extracts, and executes the official Windows x64 artifact contract', async () => {
            osMock.platform.mockReturnValue('win32');
            osMock.arch.mockReturnValue('x64');
            const archive = makeWindowsArchive();
            const digest = crypto.createHash('sha256').update(archive).digest('hex');
            configureHttpsOnce({ body: archive });
            configureHttpsOnce({ body: `${digest}  ${artifact}\n` });
            const s = new EcaServer();

            await s.downloadServer(version);

            const managedBinary = s.getManagedBinaryPath();
            expect(s.getArtifactName()).toBe(artifact);
            expect(fs.readFileSync(managedBinary)).toEqual(
                fs.readFileSync(getWindowsSourceExecutable()),
            );
            expect(s.readVersionFile()).toBe(version);
            expect(fs.readdirSync(path.dirname(managedBinary)).some((name) => name.startsWith('.eca-download-')))
                .toBe(false);
            expect(mockHttpsGet.mock.calls.map(([url]) => url)).toEqual([
                expect.stringMatching(new RegExp(`/${version}/${artifact}$`)),
                expect.stringMatching(new RegExp(`/${version}/${artifact}\\.sha256$`)),
            ]);

            const execution = spawnSync(managedBinary, ['cmd.exe'], { encoding: 'utf8' });
            expect(execution.error).toBeUndefined();
            expect(execution.status).toBe(0);
            expect(execution.stdout.toLowerCase()).toContain('cmd.exe');
        });

        it('rejects a checksum mismatch before extraction and cleans the staging directory', async () => {
            osMock.platform.mockReturnValue('win32');
            osMock.arch.mockReturnValue('x64');
            const archive = makeWindowsArchive();
            configureHttpsOnce({ body: archive });
            configureHttpsOnce({ body: `${'0'.repeat(64)}  ${artifact}\n` });
            const s = new EcaServer();

            await expect(s.downloadServer(version)).rejects.toThrow(/Checksum mismatch/);

            expect(fs.existsSync(s.getManagedBinaryPath())).toBe(false);
            expect(s.readVersionFile()).toBe('');
            expect(fs.readdirSync(path.dirname(s.getManagedBinaryPath())).some((name) => name.startsWith('.eca-download-')))
                .toBe(false);
        });

        it('rejects an archive without eca.exe and cleans the staging directory', async () => {
            osMock.platform.mockReturnValue('win32');
            osMock.arch.mockReturnValue('x64');
            const archive = makeWindowsArchive('wrong-name.exe');
            const digest = crypto.createHash('sha256').update(archive).digest('hex');
            configureHttpsOnce({ body: archive });
            configureHttpsOnce({ body: `${digest}\n` });
            const s = new EcaServer();

            await expect(s.downloadServer(version)).rejects.toThrow(/did not contain expected binary: eca\.exe/);

            expect(fs.existsSync(s.getManagedBinaryPath())).toBe(false);
            expect(fs.readdirSync(path.dirname(s.getManagedBinaryPath())).some((name) => name.startsWith('.eca-download-')))
                .toBe(false);
        });
    });

    // NOTE: `compareVersions` is module-private (not exported). Its
    // effect is only observable via the `initialize` response path in
    // start(), which requires spawning a real child_process + rpc
    // connection to exercise. Skipping per the task's guidance — the
    // function is covered indirectly by the initialize-response
    // warning log when the protocol bumps MIN_SERVER_VERSION.
    it.skip('compareVersions warns on older server versions (requires spawn mock)', () => {
        // Skipped: would require mocking child_process.spawn + vscode-jsonrpc
        // MessageConnection, which is beyond the scope of this unit test.
    });

    // NOTE: start() / stop() lifecycle and scheduleAutoRestart require
    // mocking child_process.spawn to return a fake ChildProcess and
    // vscode-jsonrpc's createMessageConnection to return a fake
    // MessageConnection. The interaction between the two (listen() +
    // sendRequest Promise.race with SERVER_INIT_TIMEOUT_MS) is
    // non-trivial to reproduce faithfully in isolation without
    // accidentally exercising real I/O. The pure helper methods above
    // already cover the testable surface that doesn't need a live
    // process.
    it.skip('start() times out on initialize and transitions to Failed (requires spawn mock)', () => {});
    it.skip('stop() escalates SIGTERM to SIGKILL after the grace window', () => {});
    it.skip('unexpected close triggers scheduleAutoRestart', () => {});
    it.skip('intentional stop suppresses auto-restart', () => {});
});
