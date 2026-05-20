import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──
//
// Replace `child_process.spawn` with a vi.fn() so each test can return
// a controllable fake child. `vi.hoisted` keeps the mock factory
// reference reachable from the hoisted vi.mock call.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { resolveShellEnv, clearShellEnvCache } from '../shell-env';

// ── Fake-child helper ──
//
// Returns an EventEmitter shaped like a ChildProcess: it carries
// `stdout` / `stderr` sub-emitters and a `kill` spy. After the next
// tick it (a) emits the configured stdout/stderr chunks and the
// `close` event, or (b) emits an `error` event, or (c) hangs forever
// — driven by the FakeChildOptions.

interface FakeChildOptions {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    exitCode?: number | null;
    error?: Error;
    /** When true, never emit close/error — useful for timeout tests. */
    hang?: boolean;
}

type FakeChild = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
};

function makeFakeChild(opts: FakeChildOptions = {}): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = vi.fn((_signal?: string) => {
        child.killed = true;
        return true;
    });

    if (!opts.hang) {
        process.nextTick(() => {
            if (opts.error) {
                child.emit('error', opts.error);
                return;
            }
            for (const chunk of opts.stdoutChunks ?? []) {
                child.stdout.emit('data', Buffer.from(chunk, 'utf-8'));
            }
            for (const chunk of opts.stderrChunks ?? []) {
                child.stderr.emit('data', Buffer.from(chunk, 'utf-8'));
            }
            child.emit('close', opts.exitCode ?? 0);
        });
    }
    return child;
}

/** Synthesize a stdout blob that contains the marker emitted by the
 *  resolver inside the `-c` command argument. Tests use this to feed
 *  back a valid env JSON matching the random marker. */
function buildEnvOutput(spawnArgs: unknown[], env: Record<string, string>): string {
    const args = spawnArgs[1] as string[];
    const cmd = args[args.length - 1];
    // The production marker is `___ECA_SHELL_ENV_<hex>___` (note the
    // trailing triple-underscore). Capture the full literal so begin/end
    // markers reconstructed below match what the parser searches for.
    const match = cmd.match(/___ECA_SHELL_ENV_[a-f0-9]+___/);
    if (!match) throw new Error(`marker not found in spawn command: ${cmd}`);
    const mark = match[0];
    return `Login banner\n${mark}_BEGIN_\n${JSON.stringify(env)}\n${mark}_END_\n`;
}

/** Extract the random marker from a spawn `-c` command argument. */
function extractMark(args: unknown): string {
    const argsArr = args as string[];
    const cmd = argsArr[argsArr.length - 1];
    const m = cmd.match(/___ECA_SHELL_ENV_[a-f0-9]+___/);
    if (!m) throw new Error(`marker not found in spawn command: ${cmd}`);
    return m[0];
}

// ── Platform / env stubbing helpers ──

const TRACKED_ENV_KEYS = ['SHELL', 'TERM', 'TERM_PROGRAM', 'ECA_SKIP_SHELL_ENV'] as const;

function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('resolveShellEnv', () => {
    let savedEnv: Record<string, string | undefined> = {};
    let originalPlatform: NodeJS.Platform;

    beforeEach(() => {
        clearShellEnvCache();
        spawnMock.mockReset();

        savedEnv = {};
        for (const k of TRACKED_ENV_KEYS) {
            savedEnv[k] = process.env[k];
            Reflect.deleteProperty(process.env, k);
        }

        originalPlatform = process.platform;
        setPlatform('linux'); // sensible default; individual tests can override
    });

    afterEach(() => {
        for (const k of TRACKED_ENV_KEYS) {
            const saved = savedEnv[k];
            if (saved === undefined) Reflect.deleteProperty(process.env, k);
            else process.env[k] = saved;
        }
        setPlatform(originalPlatform);
        clearShellEnvCache();
        vi.useRealTimers();
    });

    describe('guard rails', () => {
        it('returns {} on Windows without spawning', async () => {
            setPlatform('win32');
            const result = await resolveShellEnv();
            expect(result).toEqual({});
            expect(spawnMock).not.toHaveBeenCalled();
        });

        it('returns {} when ECA_SKIP_SHELL_ENV=1', async () => {
            process.env.ECA_SKIP_SHELL_ENV = '1';
            const result = await resolveShellEnv();
            expect(result).toEqual({});
            expect(spawnMock).not.toHaveBeenCalled();
        });

        it('returns {} when TERM_PROGRAM is set (CLI heuristic)', async () => {
            process.env.TERM_PROGRAM = 'Apple_Terminal';
            const result = await resolveShellEnv();
            expect(result).toEqual({});
            expect(spawnMock).not.toHaveBeenCalled();
        });

        it('returns {} when TERM is set (CLI heuristic)', async () => {
            process.env.TERM = 'xterm-256color';
            const result = await resolveShellEnv();
            expect(result).toEqual({});
            expect(spawnMock).not.toHaveBeenCalled();
        });

        it('returns {} when enabled=false (preference)', async () => {
            const result = await resolveShellEnv({ enabled: false });
            expect(result).toEqual({});
            expect(spawnMock).not.toHaveBeenCalled();
        });
    });

    describe('happy path', () => {
        it('parses the env and uses -i -l -c for zsh', async () => {
            process.env.SHELL = '/bin/zsh';
            spawnMock.mockImplementation((shell, args) => {
                expect(shell).toBe('/bin/zsh');
                expect((args as string[]).slice(0, 3)).toEqual(['-i', '-l', '-c']);
                return makeFakeChild({
                    stdoutChunks: [buildEnvOutput([shell, args], {
                        PATH: '/usr/local/bin:/usr/bin:/bin',
                        HOMEBREW_PREFIX: '/opt/homebrew',
                        NVM_DIR: '/Users/x/.nvm',
                    })],
                });
            });
            const result = await resolveShellEnv();
            expect(result.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
            expect(result.HOMEBREW_PREFIX).toBe('/opt/homebrew');
            expect(result.NVM_DIR).toBe('/Users/x/.nvm');
        });

        it('uses fish-specific args (-l -i -c) for fish', async () => {
            process.env.SHELL = '/usr/local/bin/fish';
            spawnMock.mockImplementation((shell, args) => {
                expect(shell).toBe('/usr/local/bin/fish');
                expect((args as string[]).slice(0, 3)).toEqual(['-l', '-i', '-c']);
                return makeFakeChild({
                    stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/x' })],
                });
            });
            const result = await resolveShellEnv();
            expect(result.PATH).toBe('/x');
        });

        it('uses plain -c for tcsh (no -i / -l)', async () => {
            process.env.SHELL = '/bin/tcsh';
            spawnMock.mockImplementation((shell, args) => {
                const a = args as string[];
                expect(a[0]).toBe('-c');
                expect(a.length).toBe(2);
                return makeFakeChild({
                    stdoutChunks: [buildEnvOutput([shell, a], { PATH: '/x' })],
                });
            });
            const result = await resolveShellEnv();
            expect(result.PATH).toBe('/x');
        });

        it('falls back to /bin/zsh on darwin when $SHELL is unset', async () => {
            setPlatform('darwin');
            spawnMock.mockImplementation((shell, args) => {
                expect(shell).toBe('/bin/zsh');
                return makeFakeChild({
                    stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/p' })],
                });
            });
            const result = await resolveShellEnv();
            expect(result.PATH).toBe('/p');
        });

        it('falls back to /bin/bash on linux when $SHELL is unset', async () => {
            spawnMock.mockImplementation((shell, args) => {
                expect(shell).toBe('/bin/bash');
                return makeFakeChild({
                    stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/p' })],
                });
            });
            const result = await resolveShellEnv();
            expect(result.PATH).toBe('/p');
        });

        it('sets ECA_RESOLVING_ENVIRONMENT and ELECTRON_RUN_AS_NODE on the spawned shell', async () => {
            let observedEnv: NodeJS.ProcessEnv | undefined;
            spawnMock.mockImplementation((shell, args, options) => {
                observedEnv = (options as { env: NodeJS.ProcessEnv }).env;
                return makeFakeChild({
                    stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/p' })],
                });
            });
            await resolveShellEnv();
            expect(observedEnv?.ECA_RESOLVING_ENVIRONMENT).toBe('1');
            expect(observedEnv?.ELECTRON_RUN_AS_NODE).toBe('1');
        });

        it('strips ECA_RESOLVING_ENVIRONMENT and ELECTRON_RUN_AS_NODE from the returned env', async () => {
            spawnMock.mockImplementation((_shell, args) => {
                const mark = extractMark(args);
                const env = {
                    PATH: '/x',
                    ECA_RESOLVING_ENVIRONMENT: '1',
                    ELECTRON_RUN_AS_NODE: '1',
                };
                return makeFakeChild({
                    stdoutChunks: [`${mark}_BEGIN_${JSON.stringify(env)}${mark}_END_`],
                });
            });
            const result = await resolveShellEnv();
            expect(result.PATH).toBe('/x');
            expect(result.ECA_RESOLVING_ENVIRONMENT).toBeUndefined();
            expect(result.ELECTRON_RUN_AS_NODE).toBeUndefined();
        });

        it('caches the resolved env across subsequent calls', async () => {
            spawnMock.mockImplementation((shell, args) => makeFakeChild({
                stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/cached' })],
            }));
            const a = await resolveShellEnv();
            const b = await resolveShellEnv();
            expect(a).toBe(b); // same reference — same Promise resolved value
            expect(spawnMock).toHaveBeenCalledTimes(1);
        });

        it('re-resolves after clearShellEnvCache()', async () => {
            spawnMock.mockImplementation((shell, args) => makeFakeChild({
                stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/first' })],
            }));
            const first = await resolveShellEnv();
            expect(first.PATH).toBe('/first');

            clearShellEnvCache();
            spawnMock.mockImplementation((shell, args) => makeFakeChild({
                stdoutChunks: [buildEnvOutput([shell, args], { PATH: '/second' })],
            }));
            const second = await resolveShellEnv();
            expect(second.PATH).toBe('/second');
            expect(spawnMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('failure paths', () => {
        it('returns {} when stdout has no marker', async () => {
            spawnMock.mockImplementation(() => makeFakeChild({
                stdoutChunks: ['definitely not the marker output'],
            }));
            const result = await resolveShellEnv();
            expect(result).toEqual({});
        });

        it('returns {} when JSON inside the marker is malformed', async () => {
            spawnMock.mockImplementation((_shell, args) => {
                const mark = extractMark(args);
                return makeFakeChild({
                    stdoutChunks: [`${mark}_BEGIN_not-json-at-all${mark}_END_`],
                });
            });
            const result = await resolveShellEnv();
            expect(result).toEqual({});
        });

        it('returns {} when payload is an array (not an env object)', async () => {
            spawnMock.mockImplementation((_shell, args) => {
                const mark = extractMark(args);
                return makeFakeChild({
                    stdoutChunks: [`${mark}_BEGIN_[1,2,3]${mark}_END_`],
                });
            });
            const result = await resolveShellEnv();
            expect(result).toEqual({});
        });

        it('returns {} when payload contains non-string values', async () => {
            spawnMock.mockImplementation((_shell, args) => {
                const mark = extractMark(args);
                return makeFakeChild({
                    stdoutChunks: [`${mark}_BEGIN_${JSON.stringify({ PATH: 1 })}${mark}_END_`],
                });
            });
            const result = await resolveShellEnv();
            expect(result).toEqual({});
        });

        it('returns {} on non-zero exit code', async () => {
            spawnMock.mockImplementation(() => makeFakeChild({ exitCode: 127 }));
            const result = await resolveShellEnv();
            expect(result).toEqual({});
        });

        it('returns {} on spawn error (ENOENT)', async () => {
            spawnMock.mockImplementation(() => makeFakeChild({
                error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
            }));
            const result = await resolveShellEnv();
            expect(result).toEqual({});
        });

        it('returns {} on timeout and sends SIGTERM to the child', async () => {
            vi.useFakeTimers();
            const child = makeFakeChild({ hang: true });
            spawnMock.mockImplementation(() => child);

            const promise = resolveShellEnv({ timeoutMs: 2_000 });
            // Advance just past the timeout (but before the 1s SIGKILL follow-up).
            await vi.advanceTimersByTimeAsync(2_500);

            const result = await promise;
            expect(result).toEqual({});
            expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        });

        it('logs diagnostics via onLog', async () => {
            const logs: string[] = [];
            spawnMock.mockImplementation(() => makeFakeChild({ exitCode: 42 }));
            await resolveShellEnv({ onLog: (m) => logs.push(m) });
            // At minimum: one "Resolving" line and one "exited with code 42" line.
            expect(logs.some((l) => l.includes('Resolving shell env'))).toBe(true);
            expect(logs.some((l) => l.includes('code 42'))).toBe(true);
        });
    });
});
