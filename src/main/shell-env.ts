// ============================================================
// shell-env — resolve the user's login+interactive shell env
//
// Why this exists:
//   macOS (and to a lesser extent Linux) GUI apps launched from
//   Finder / Dock / launchctl inherit a minimal PATH (commonly
//   `/usr/bin:/bin:/usr/sbin:/sbin`) — none of the user's dotfile
//   additions (homebrew, asdf, nvm, fnm, pnpm, ...). The ECA server
//   we spawn then can't find any of the tools the user installed
//   through their package manager.
//
//   This module spawns the user's preferred shell as a login +
//   interactive shell, asks it to print its resolved env as JSON,
//   and returns that env so callers can merge it into the ECA
//   spawn's `env` option. Behavior follows VSCode's well-trodden
//   `resolveShellEnv` pattern (cache, timeout, marker env var,
//   platform/CLI guards, opt-out).
//
// Surfaces failures gracefully — every error path resolves to `{}`
// so callers never block on shell env resolution; the ECA spawn
// simply falls back to today's behavior (inherit Electron's env).
// ============================================================

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';

export interface ResolveShellEnvOptions {
    /**
     * Maximum wall-clock time (ms) to wait for the shell to print its
     * env. Clamped to `[1_000, 120_000]`. Default `10_000`.
     */
    timeoutMs?: number;
    /**
     * Master switch. When `false`, resolution is skipped and `{}` is
     * returned. Default `true`.
     */
    enabled?: boolean;
    /**
     * Diagnostic logging hook. Invoked synchronously for each log line.
     * No-op by default.
     */
    onLog?: (msg: string) => void;
}

// Module-level singleton cache. The shell env doesn't change during
// the lifetime of the Electron main process — the cost (spawning a
// login shell that sources every rc file) only needs to be paid once.
let cachedPromise: Promise<NodeJS.ProcessEnv> | null = null;

/**
 * Resolve the user's shell environment. See module docstring for the
 * motivation. Cached after the first call; use `clearShellEnvCache()`
 * to force re-resolution (mostly useful from tests).
 *
 * Returns `{}` (a no-op env patch) on Windows, when disabled by
 * preference, when `ECA_SKIP_SHELL_ENV=1` is set, when the app looks
 * like it was launched from a terminal already, or on any failure.
 */
export function resolveShellEnv(opts: ResolveShellEnvOptions = {}): Promise<NodeJS.ProcessEnv> {
    const log = opts.onLog ?? ((): void => { /* noop */ });

    if (cachedPromise) return cachedPromise;

    // ── Guard rails ────────────────────────────────────────
    if (opts.enabled === false) {
        log('Shell env resolution disabled by preference.');
        return Promise.resolve({});
    }
    if (process.platform === 'win32') {
        // Windows GUI apps inherit the user's PATH from the per-user
        // environment — no workaround needed.
        return Promise.resolve({});
    }
    if (process.env.ECA_SKIP_SHELL_ENV === '1') {
        log('Shell env resolution skipped (ECA_SKIP_SHELL_ENV=1).');
        return Promise.resolve({});
    }
    if (isLikelyLaunchedFromCli()) {
        log('Shell env resolution skipped (looks like launched from a terminal).');
        return Promise.resolve({});
    }

    const timeoutMs = clampTimeout(opts.timeoutMs ?? 10_000);
    cachedPromise = doResolve(timeoutMs, log);
    return cachedPromise;
}

/** Drop the cache. Mostly used from tests; production callers don't
 *  normally need this (the env doesn't change during process lifetime). */
export function clearShellEnvCache(): void {
    cachedPromise = null;
}

function clampTimeout(ms: number): number {
    if (!Number.isFinite(ms)) return 10_000;
    return Math.min(120_000, Math.max(1_000, Math.floor(ms)));
}

/**
 * Heuristic: if the app was launched from a terminal (Terminal.app,
 * iTerm, GNOME Terminal, a CI runner, ...), the parent process's env
 * is already correct and resolving the shell env again is wasted work
 * (and might even produce a confusing result if the user has nested
 * shells). When launched from Finder / Dock / launchctl, neither
 * `TERM_PROGRAM` nor `TERM` is propagated.
 */
function isLikelyLaunchedFromCli(): boolean {
    if (process.env.TERM_PROGRAM) return true;
    if (process.env.TERM) return true;
    return false;
}

/** Resolve the user's shell binary path. Falls back to a sensible
 *  default per platform when `$SHELL` is unset. */
function detectShell(): string {
    const fromEnv = process.env.SHELL?.trim();
    if (fromEnv) return fromEnv;
    return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/** Args needed to make `<shell>` evaluate `command` as an interactive
 *  login shell that sources the user's dotfiles. fish takes its flags
 *  in a different order; csh/tcsh don't support `-i` reliably and we
 *  fall back to `-c` only. */
function shellArgs(shell: string, command: string): string[] {
    const name = path.basename(shell);
    if (name === 'fish') return ['-l', '-i', '-c', command];
    if (name === 'csh' || name === 'tcsh') return ['-c', command];
    // bash, zsh, ksh, dash, sh, etc.
    return ['-i', '-l', '-c', command];
}

/** sh-style single-quote escaping for embedding a path inside the
 *  `-c` command string. Replaces `'` with `'\''` (close-quote, escaped
 *  literal quote, re-open-quote). Safe against shell metacharacters. */
function shellEscape(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function doResolve(timeoutMs: number, log: (msg: string) => void): Promise<NodeJS.ProcessEnv> {
    const shell = detectShell();
    // Random marker so we can robustly extract the JSON payload from
    // anything else the user's dotfiles print to stdout (login banners,
    // `fastfetch`, fortune cookies, ...).
    const mark = `___ECA_SHELL_ENV_${crypto.randomBytes(8).toString('hex')}___`;
    const beginMark = `${mark}_BEGIN_`;
    const endMark = `${mark}_END_`;

    // We invoke `process.execPath` (the Electron binary, or `node` in
    // tests) under `ELECTRON_RUN_AS_NODE=1` to JSON-stringify the
    // shell's env. Doing it in-process means we don't depend on any
    // tool being on the user's PATH (other than the shell itself).
    const execPath = shellEscape(process.execPath);
    const command =
        `echo "${beginMark}"; `
        + `${execPath} -e 'process.stdout.write(JSON.stringify(process.env))'; `
        + `echo; `
        + `echo "${endMark}"`;
    const args = shellArgs(shell, command);

    log(`Resolving shell env via ${shell} ${args.slice(0, -1).join(' ')} <cmd>`);

    try {
        const { stdout, stderr, code } = await spawnAndCollect(shell, args, timeoutMs, log);
        if (code !== 0) {
            log(`Shell exited with code ${code}. stderr: ${truncate(stderr, 500)}`);
            return {};
        }
        const parsed = parseShellEnv(stdout, beginMark, endMark);
        if (!parsed) {
            log(`Could not parse shell env output. stdout head: ${truncate(stdout, 300)}`);
            return {};
        }
        // Drop the marker var so we never propagate it to spawned children.
        delete parsed.ECA_RESOLVING_ENVIRONMENT;
        // Drop ELECTRON_RUN_AS_NODE too — we set it for the shell so
        // its child Electron binary acts as Node; we don't want it on
        // the ECA server child (where it would force Electron-as-Node
        // and break the spawn).
        delete parsed.ELECTRON_RUN_AS_NODE;
        log(`Resolved shell env (${Object.keys(parsed).length} vars). PATH: ${truncate(parsed.PATH ?? '<unset>', 200)}`);
        return parsed;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Shell env resolution failed: ${msg}`);
        return {};
    }
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}...` : s;
}

function parseShellEnv(stdout: string, beginMark: string, endMark: string): NodeJS.ProcessEnv | null {
    const start = stdout.indexOf(beginMark);
    const end = stdout.indexOf(endMark);
    if (start < 0 || end < 0 || end <= start) return null;
    const json = stdout.slice(start + beginMark.length, end).trim();
    try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        // Narrow to ProcessEnv shape — every value must be a string (or
        // undefined). Anything else is a sign the user's shell printed
        // unexpected data and we should bail.
        for (const v of Object.values(parsed)) {
            if (typeof v !== 'string' && v !== undefined) return null;
        }
        return parsed as NodeJS.ProcessEnv;
    } catch {
        return null;
    }
}

interface SpawnCollectResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * Spawn the shell, collect stdout/stderr, and resolve when it exits.
 * On timeout, send SIGTERM (with a SIGKILL follow-up after 1s) and
 * reject. Errors (ENOENT, signal, non-zero exit) are returned to the
 * caller via the resolved/rejected promise; the caller in `doResolve`
 * downgrades all of them to `{}`.
 */
function spawnAndCollect(
    shell: string,
    args: string[],
    timeoutMs: number,
    log: (msg: string) => void,
): Promise<SpawnCollectResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(shell, args, {
            env: {
                ...process.env,
                // Marker so users can guard slow blocks (tmux auto-attach,
                // ssh-agent startup, `nvm` shimming, ...) in their dotfiles
                // like:
                //   [ -z "$ECA_RESOLVING_ENVIRONMENT" ] && tmux attach
                // VSCode uses the equivalent VSCODE_RESOLVING_ENVIRONMENT.
                ECA_RESOLVING_ENVIRONMENT: '1',
                // Force the inner Electron invocation (process.execPath) to
                // behave as a normal Node binary. Has no effect on a real
                // `node` binary, which is what runs in tests.
                ELECTRON_RUN_AS_NODE: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            log(`Shell env resolution timed out after ${timeoutMs}ms; killing shell.`);
            try { child.kill('SIGTERM'); } catch { /* noop */ }
            // SIGKILL follow-up so a wedged shell doesn't linger as a zombie.
            setTimeout(() => {
                try { if (!child.killed) child.kill('SIGKILL'); } catch { /* noop */ }
            }, 1_000);
            reject(new Error(`shell env resolution timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer | string) => {
            stdout += typeof chunk === 'string' ? chunk : chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
            stderr += typeof chunk === 'string' ? chunk : chunk.toString();
        });
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code: code ?? 0 });
        });
    });
}
