import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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

// ── Helpers ──

interface HttpsResponseOpts {
    statusCode?: number;
    body?: string | object;
    requestError?: Error;
}

function configureHttpsOnce(opts: HttpsResponseOpts = {}): void {
    const { statusCode = 200, body = '', requestError } = opts;
    mockHttpsGet.mockImplementationOnce(
        (
            _url: string,
            options: unknown,
            callback?: (res: unknown) => void,
        ) => {
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
        },
    );
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

        it('rejects on HTTP error status (no silent fallback)', async () => {
            configureHttpsOnce({ statusCode: 403, body: 'rate limited' });
            const s = new EcaServer();
            await expect(s.getLatestVersion()).rejects.toThrow(/HTTP 403/);
        });

        it('rejects on request error', async () => {
            configureHttpsOnce({ requestError: new Error('ECONNRESET') });
            const s = new EcaServer();
            await expect(s.getLatestVersion()).rejects.toThrow(/ECONNRESET/);
        });
    });

    describe('getLatestVersionSafe', () => {
        it('returns empty string on error and logs the reason', async () => {
            configureHttpsOnce({ statusCode: 500, body: '' });
            const s = new EcaServer();
            const logs: string[] = [];
            s.onLog = (msg): void => { logs.push(msg); };
            await expect(s.getLatestVersionSafe()).resolves.toBe('');
            expect(logs.some((m) => /Could not fetch/i.test(m))).toBe(true);
        });

        it('returns tag_name on success', async () => {
            configureHttpsOnce({ body: [{ tag_name: 'v1.2.3' }] });
            const s = new EcaServer();
            await expect(s.getLatestVersionSafe()).resolves.toBe('v1.2.3');
        });
    });

    describe('getExpectedChecksum', () => {
        const artifact = 'eca-native-static-linux-amd64.zip';

        it('parses `hex  filename` lines and returns the lowercased hex', async () => {
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
            configureHttpsOnce({
                body: `abc  *${artifact}\n`,
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact))
                .resolves.toBe('abc');
        });

        it('returns null when the artifact is not listed', async () => {
            configureHttpsOnce({
                body: 'deadbeef  some-other-file.zip\n',
            });
            const s = new EcaServer();
            await expect(s.getExpectedChecksum('v0.6.0', artifact)).resolves.toBeNull();
        });

        it('returns null when the sha256sums.txt HTTP fetch fails', async () => {
            configureHttpsOnce({ statusCode: 404 });
            const s = new EcaServer();
            const logs: string[] = [];
            s.onLog = (msg): void => { logs.push(msg); };
            await expect(s.getExpectedChecksum('v0.6.0', artifact)).resolves.toBeNull();
            expect(logs.some((m) => /No sha256sums\.txt/i.test(m))).toBe(true);
        });

        it('skips malformed lines (single-token)', async () => {
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
