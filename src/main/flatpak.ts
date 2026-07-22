// ============================================================
// flatpak — Flatpak sandbox detection and host-spawn helpers
//
// Why this exists:
//   Inside a Flatpak sandbox only the freedesktop runtime is
//   visible — none of the user's toolchain (git, shells, node,
//   package managers, MCP servers, ...) that the ECA server needs
//   to be useful as a coding agent. When sandboxed, the server is
//   therefore spawned on the *host* through `flatpak-spawn --host`,
//   which proxies the spawn over the org.freedesktop.Flatpak D-Bus
//   portal (granted in the packaging manifest via
//   `--talk-name=org.freedesktop.Flatpak`). stdio is forwarded, so
//   the JSON-RPC stdio transport works unchanged; catchable signals
//   (SIGTERM) are forwarded to the host process; and `--watch-bus`
//   ties the host process's lifetime to the proxy's so even a
//   SIGKILL on the proxy can't orphan the server.
//
//   Only the server (and its children) escape the sandbox — the
//   Electron UI itself stays confined.
//
// Every helper degrades gracefully: when the portal is unavailable
// (`hostSpawnAvailable` → false) callers fall back to in-sandbox
// behavior instead of failing.
// ============================================================

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export const FLATPAK_SPAWN = 'flatpak-spawn';

/**
 * Args used to run the long-lived ECA server on the host.
 * `--watch-bus` makes the host process exit when the caller vanishes
 * from the session bus (proxy killed, app quit), which covers the one
 * signal flatpak-spawn cannot forward: SIGKILL.
 */
export const HOST_SPAWN_ARGS: readonly string[] = ['--host', '--watch-bus'];

/** True when running inside a Flatpak sandbox. */
export function isFlatpak(): boolean {
    if (process.env.FLATPAK_ID) return true;
    try {
        return fs.existsSync('/.flatpak-info');
    } catch {
        return false;
    }
}

/**
 * True when `dir` looks like the Flatpak per-app XDG remap
 * (`~/.var/app/<id>/...`) rather than a value the user chose
 * deliberately. Flatpak always exports XDG_CONFIG_HOME & friends
 * pointing into the app's private storage; treating that as a real
 * user preference would make the desktop read/write a config that the
 * eca server running on the host never sees.
 */
export function isFlatpakPrivateXdgDir(dir: string): boolean {
    // Flatpak is Linux-only; the remap is always a POSIX path (using
    // path.sep here broke on Windows, where it is a backslash).
    return isFlatpak() && dir.includes('/.var/app/');
}

/**
 * Env vars that only make sense inside the sandbox and must not leak
 * to host-spawned processes. Notes:
 *   - The XDG_*_HOME remaps point into `~/.var/app/<id>/...`; leaked
 *     to the host ECA server they'd redirect its config/cache into
 *     the sandbox's private storage.
 *   - LD_* / *_DIRS reference /app and the runtime image, which don't
 *     exist (or worse, half-exist) on the host.
 *   - PATH is deliberately KEPT: the sandbox value (/app/bin:/usr/bin)
 *     degrades gracefully on the host, and the host login-shell env
 *     resolved by shell-env.ts overrides it with the real one anyway.
 */
const SANDBOX_ONLY_ENV = new Set([
    'FLATPAK_ID',
    'FLATPAK_SANDBOX_DIR',
    'container',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_CONFIG_DIRS',
    'XDG_DATA_DIRS',
    'LD_LIBRARY_PATH',
    'LD_PRELOAD',
    'GI_TYPELIB_PATH',
    // zypak — the Electron BaseApp's chromium-sandbox shim.
    'ZYPAK_BIN',
    'ZYPAK_LIB',
]);

/** Copy of `env` with sandbox-only variables removed. */
export function sanitizeEnvForHost(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (!SANDBOX_ONLY_ENV.has(key)) {
            out[key] = value;
        }
    }
    return out;
}

// Cached probes. Neither answer can change during the process
// lifetime, and the server restart path must not re-pay the probe
// cost on every attempt.
let hostSpawnProbe: Promise<boolean> | null = null;
let cachedHostShell: Promise<string> | null = null;

/**
 * Whether `flatpak-spawn --host` actually works from this sandbox.
 * Probes with the exact flags used for the real server spawn, so a
 * `true` here validates the portal permission end to end. Always
 * `false` outside Flatpak.
 */
export function hostSpawnAvailable(onLog?: (msg: string) => void): Promise<boolean> {
    if (!isFlatpak()) return Promise.resolve(false);
    if (hostSpawnProbe) return hostSpawnProbe;
    hostSpawnProbe = probeHostSpawn(onLog ?? ((): void => { /* noop */ }));
    return hostSpawnProbe;
}

/** Drop cached probe results. Mostly useful from tests. */
export function clearFlatpakCaches(): void {
    hostSpawnProbe = null;
    cachedHostShell = null;
}

function probeHostSpawn(log: (msg: string) => void): Promise<boolean> {
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            // `true` is the cheapest host command that proves the whole
            // pipeline: flatpak-spawn exists, the portal talk permission
            // is granted, and our exact flag combination is accepted.
            child = spawn(FLATPAK_SPAWN, [...HOST_SPAWN_ARGS, 'true'], { stdio: 'ignore' });
        } catch (err) {
            log(`flatpak-spawn probe failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
            resolve(false);
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            log('flatpak-spawn --host probe timed out after 10s — falling back to in-sandbox server spawn.');
            try { child.kill('SIGKILL'); } catch { /* noop */ }
            resolve(false);
        }, 10_000);
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            log(`flatpak-spawn --host probe errored (${err.message}) — falling back to in-sandbox server spawn.`);
            resolve(false);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                log(`flatpak-spawn --host probe exited with code ${code} — falling back to in-sandbox server spawn (is --talk-name=org.freedesktop.Flatpak granted?).`);
            }
            resolve(code === 0);
        });
    });
}

/**
 * The user's login shell on the HOST. `$SHELL` inside the sandbox and
 * /etc/passwd inside the runtime image are both unreliable, so ask
 * the host's user database via `getent`. Falls back to `$SHELL`, then
 * /bin/bash.
 */
export function detectHostShell(onLog?: (msg: string) => void): Promise<string> {
    if (cachedHostShell) return cachedHostShell;
    const log = onLog ?? ((): void => { /* noop */ });
    cachedHostShell = queryHostLoginShell(log)
        .then((shell) => shell ?? fallbackShell())
        .catch(() => fallbackShell());
    return cachedHostShell;
}

function fallbackShell(): string {
    const fromEnv = process.env.SHELL?.trim();
    return fromEnv && fromEnv.length > 0 ? fromEnv : '/bin/bash';
}

function queryHostLoginShell(log: (msg: string) => void): Promise<string | null> {
    return new Promise((resolve) => {
        let username: string;
        try {
            username = os.userInfo().username;
        } catch {
            resolve(null);
            return;
        }
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(FLATPAK_SPAWN, ['--host', 'getent', 'passwd', username], {
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch {
            resolve(null);
            return;
        }
        let stdout = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch { /* noop */ }
            resolve(null);
        }, 5_000);
        child.stdout?.on('data', (chunk: Buffer | string) => {
            stdout += typeof chunk === 'string' ? chunk : chunk.toString();
        });
        child.on('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                resolve(null);
                return;
            }
            // Line shape: `user:x:1000:1000:Name:/home/user:/usr/bin/zsh`
            const line = stdout.split('\n').find((l) => l.startsWith(`${username}:`));
            const shell = line?.split(':')[6]?.trim();
            if (shell && shell.startsWith('/')) {
                log(`Host login shell (via getent): ${shell}`);
                resolve(shell);
            } else {
                resolve(null);
            }
        });
    });
}
