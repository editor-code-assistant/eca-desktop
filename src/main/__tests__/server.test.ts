import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Mocks ──
//
// Mock `os` so we can vary platform/arch per test without touching the
// real host. Spread the real module so things like homedir() still work
// (constants.ts and fs helpers rely on them).
const osMock = vi.hoisted(() => ({
    platform: vi.fn(() => 'linux' as NodeJS.Platform),
    arch: vi.fn(() => 'x64' as string),
}));
vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return {
        ...actual,
        platform: (...args: unknown[]) => osMock.platform(...(args as [])),
        arch: (...args: unknown[]) => osMock.arch(...(args as [])),
        default: { ...actual, platform: () => osMock.platform(), arch: () => osMock.arch() },
    };
});

// Mock `fs` with a passthrough renameSync that individual tests can
// override (vi.spyOn can't patch the non-configurable ESM namespace).
type RenameSyncFn = (oldPath: fs.PathLike, newPath: fs.PathLike) => void;
const fsMock = vi.hoisted(() => ({
    renameSync: undefined as RenameSyncFn | undefined,
    actualRenameSync: undefined as RenameSyncFn | undefined,
}));
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>();
    fsMock.actualRenameSync = actual.renameSync;
    const renameSync: RenameSyncFn = (oldPath, newPath) =>
        (fsMock.renameSync ?? actual.renameSync)(oldPath, newPath);
    return {
        ...actual,
        renameSync,
        default: { ...actual, renameSync },
    };
});

// Mock `child_process` so killServerProcess tests can observe taskkill
// spawns. start()/stop() lifecycle tests are skipped (see EOF notes), so
// nothing else in this file spawns.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const spawn = (...args: unknown[]) => spawnMock(...args);
    return { ...actual, spawn, default: { ...actual, spawn } };
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

import { EcaServer, EcaServerStatus, killServerProcess } from '../server';
import { HTTP_MAX_RETRIES } from '../constants';
import type { ChildProcess } from 'child_process';

// ── Helpers ──

interface HttpsResponseOpts {
    statusCode?: number;
    body?: string | object;
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
            const res = new EventEmitter() as EventEmitter & {
                statusCode?: number;
                resume: () => void;
            };
            res.statusCode = statusCode;
            res.resume = (): void => { /* noop */ };
            cb(res);
            // Error path: don't emit data/end.
            if (statusCode >= 200 && statusCode < 300) {
                const text = typeof body === 'string' ? body : JSON.stringify(body);
                res.emit('data', text);
                res.emit('end');
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
    });

    afterEach(() => {
        vi.useRealTimers();
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            osMock.platform.mockReturnValue('freebsd' as any);
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

        // The per-artifact `<artifact>.sha256` fetch now precedes the
        // sha256sums.txt fallback. A successful-but-garbage response is
        // the cheapest way to reach the fallback in tests without
        // driving the 404 retry loop's backoff timers.
        const artifactShaMiss = (): void => {
            configureHttpsOnce({ body: 'not a checksum' });
        };

        it('returns the digest from the per-artifact .sha256 asset', async () => {
            configureHttpsOnce({ body: `${hex64.toUpperCase()}\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe(hex64);
        });

        it('tolerates `hex  filename` format in the per-artifact asset', async () => {
            configureHttpsOnce({ body: `${hex64}  ${artifact}\n` });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe(hex64);
        });

        it('falls back to sha256sums.txt when the artifact asset is missing', async () => {
            vi.useFakeTimers();
            // The .sha256 fetch 404s through its whole retry budget first.
            for (let i = 0; i < HTTP_MAX_RETRIES + 1; i++) {
                configureHttpsOnce({ statusCode: 404 });
            }
            configureHttpsOnce({ body: `abc123  ${artifact}\n` });
            const s = new EcaServer();
            const promise = s.getExpectedChecksum('v0.6.0', artifact);
            await expect(awaitWithFakeTimers(promise)).resolves.toBe('abc123');
        });

        it('parses `hex  filename` lines and returns the lowercased hex', async () => {
            artifactShaMiss();
            configureHttpsOnce({
                body: [
                    'deadbeef  eca-native-macos-amd64.zip',
                    `CAFEBABE  ${artifact}`,
                    'f00df00d  eca-native-windows-amd64.zip',
                ].join('\n'),
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe('cafebabe');
        });

        it('ignores # comments and blank lines', async () => {
            artifactShaMiss();
            configureHttpsOnce({
                body: [
                    '# ECA checksums',
                    '',
                    '   ',
                    `abc123  ${artifact}`,
                ].join('\n'),
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe('abc123');
        });

        it('tolerates GNU `*filename` binary-mode marker', async () => {
            artifactShaMiss();
            configureHttpsOnce({
                body: `abc  *${artifact}\n`,
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe('abc');
        });

        it('returns null when the artifact is not listed', async () => {
            artifactShaMiss();
            configureHttpsOnce({
                body: 'deadbeef  some-other-file.zip\n',
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact)).resolves.toBeNull();
        });

        it('returns null after exhausting retries when no checksum asset exists', async () => {
            vi.useFakeTimers();
            configureHttpsAlways({ statusCode: 404 });
            const s = new EcaServer();
            const logs: string[] = [];
            s.onLog = (msg): void => { logs.push(msg); };
            const promise = s.getExpectedChecksum('v0.6.0', artifact);
            await expect(awaitWithFakeTimers(promise)).resolves.toBeNull();
            expect(logs.some((m) => /No sha256sums\.txt/i.test(m))).toBe(true);
            // Both the per-artifact and the aggregate fetch honour the
            // retry budget before giving up.
            expect(mockHttpsGet).toHaveBeenCalledTimes(2 * (HTTP_MAX_RETRIES + 1));
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

        it('skips malformed lines (single-token)', async () => {
            artifactShaMiss();
            configureHttpsOnce({
                body: [
                    'orphan-token',
                    `abc123  ${artifact}`,
                ].join('\n'),
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe('abc123');
        });
    });

    describe('installBinary', () => {
        let dir: string;
        let staged: string;
        let managed: string;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-install-'));
            staged = path.join(dir, 'staged', 'eca');
            fs.mkdirSync(path.dirname(staged));
            managed = path.join(dir, 'eca');
        });

        afterEach(() => {
            fsMock.renameSync = undefined;
            fs.rmSync(dir, { recursive: true, force: true });
        });

        /** Make the first staged→managed rename throw, as Windows does for a running exe. */
        function refuseFirstInstallRename(code: string): void {
            let refused = false;
            fsMock.renameSync = (src, dest) => {
                if (!refused && src === staged && dest === managed) {
                    refused = true;
                    throw Object.assign(new Error(`${code}: locked exe`), { code });
                }
                fsMock.actualRenameSync!(src, dest);
            };
        }

        it('renames the staged binary over the managed path', () => {
            fs.writeFileSync(staged, 'new');
            fs.writeFileSync(managed, 'old');
            new EcaServer().installBinary(staged, managed);
            expect(fs.readFileSync(managed, 'utf8')).toBe('new');
            expect(fs.existsSync(staged)).toBe(false);
        });

        it('parks a locked binary aside and installs (Windows rename-over refusal)', () => {
            fs.writeFileSync(staged, 'new');
            fs.writeFileSync(managed, 'old');
            refuseFirstInstallRename('EPERM');
            new EcaServer().installBinary(staged, managed);
            expect(fs.readFileSync(managed, 'utf8')).toBe('new');
            const parked = fs.readdirSync(dir).filter((e) => e.startsWith('eca.old-'));
            expect(parked).toHaveLength(1);
            expect(fs.readFileSync(path.join(dir, parked[0]), 'utf8')).toBe('old');
        });

        it('falls back to unlink when rename-aside is impossible, then installs', () => {
            fs.writeFileSync(staged, 'new');
            // No managed binary on disk: rename-aside and unlink both ENOENT.
            refuseFirstInstallRename('EACCES');
            new EcaServer().installBinary(staged, managed);
            expect(fs.readFileSync(managed, 'utf8')).toBe('new');
        });

        it('removes stale parked binaries from previous installs', () => {
            fs.writeFileSync(staged, 'new');
            fs.writeFileSync(managed, 'old');
            fs.writeFileSync(path.join(dir, 'eca.old-1700000000000'), 'stale');
            new EcaServer().installBinary(staged, managed);
            expect(fs.readdirSync(dir).some((e) => e.startsWith('eca.old-'))).toBe(false);
        });
    });

    describe('killServerProcess', () => {
        beforeEach(() => {
            spawnMock.mockReset();
        });

        function fakeProc(pid: number | undefined): { proc: ChildProcess; kill: ReturnType<typeof vi.fn> } {
            const kill = vi.fn();
            return { proc: { pid, kill } as unknown as ChildProcess, kill };
        }

        it('sends the signal directly on POSIX', () => {
            const { proc, kill } = fakeProc(42);
            killServerProcess(proc, 'SIGTERM');
            expect(kill).toHaveBeenCalledWith('SIGTERM');
            expect(spawnMock).not.toHaveBeenCalled();
        });

        it('kills the whole tree via taskkill on win32', () => {
            osMock.platform.mockReturnValue('win32');
            spawnMock.mockReturnValue(new EventEmitter());
            const { proc, kill } = fakeProc(42);
            killServerProcess(proc, 'SIGTERM');
            expect(spawnMock).toHaveBeenCalledWith(
                'taskkill',
                ['/pid', '42', '/T', '/F'],
                { stdio: 'ignore', windowsHide: true },
            );
            expect(kill).not.toHaveBeenCalled();
        });

        it('falls back to a direct kill when taskkill cannot start', () => {
            osMock.platform.mockReturnValue('win32');
            const taskkill = new EventEmitter();
            spawnMock.mockReturnValue(taskkill);
            const { proc, kill } = fakeProc(42);
            killServerProcess(proc, 'SIGKILL');
            taskkill.emit('error', new Error('ENOENT'));
            expect(kill).toHaveBeenCalledWith('SIGKILL');
        });

        it('sends the signal directly on win32 when the pid is unavailable', () => {
            osMock.platform.mockReturnValue('win32');
            const { proc, kill } = fakeProc(undefined);
            killServerProcess(proc, 'SIGTERM');
            expect(kill).toHaveBeenCalledWith('SIGTERM');
            expect(spawnMock).not.toHaveBeenCalled();
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
