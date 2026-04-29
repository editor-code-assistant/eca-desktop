// ============================================================
// Shared constants — extracted from across the codebase
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── GitHub / Server ──

export const GITHUB_RELEASES_API = 'https://api.github.com/repos/editor-code-assistant/eca/releases';
export const GITHUB_RELEASES_DOWNLOAD = 'https://github.com/editor-code-assistant/eca/releases/download';
export const USER_AGENT = 'eca-desktop';

// ── Client info (sent during JSON-RPC initialize) ──

export const CLIENT_NAME = 'Desktop';
export const CLIENT_VERSION: string = require('../../package.json').version;

// ── Data directory ──

export const DATA_DIR_NAME = '.eca-desktop';

export function getDataDir(): string {
    const dir = path.join(os.homedir(), DATA_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ── ECA global config path ──

/**
 * Resolves the absolute path to the ECA global config JSON file.
 *
 * Resolution order:
 *   1. `ECA_CONFIG_PATH` environment variable (absolute path), if set.
 *   2. `$XDG_CONFIG_HOME/eca/config.json` if `XDG_CONFIG_HOME` is set.
 *   3. Platform default:
 *      - win32:   `%APPDATA%\eca\config.json` (falls back to `~/.config/eca/config.json`)
 *      - others (macOS, Linux):  `~/.config/eca/config.json`
 *
 * Note: this does not touch the filesystem. Creation is the caller's
 * responsibility.
 */
export function getGlobalConfigPath(): string {
    const override = process.env.ECA_CONFIG_PATH;
    if (override && override.trim().length > 0) {
        return override;
    }

    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.trim().length > 0) {
        return path.join(xdg, 'eca', 'config.json');
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        if (appData && appData.trim().length > 0) {
            return path.join(appData, 'eca', 'config.json');
        }
    }

    return path.join(os.homedir(), '.config', 'eca', 'config.json');
}

// ── Platform artifacts ──

export const PLATFORM_ARTIFACTS: Record<string, Record<string, string>> = {
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

// ── MIME types ──

export const MIME_TO_EXTENSION: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
};

// ── External URLs ──

export const DOCS_URL = 'https://eca.dev';
export const ISSUES_URL = 'https://github.com/editor-code-assistant/eca-desktop/issues';

// ── HTTP ──

export const HTTP_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 300_000; // 5 minutes for large binaries
// Retry up to 3 times (so a total of 4 attempts) with exponential backoff.
// Pre-launch we were only retrying once which meant a single transient GitHub
// hiccup dead-ended the first-run download — see audit finding S2.
export const DOWNLOAD_MAX_RETRIES = 3;
export const DOWNLOAD_RETRY_DELAY_MS = 2_000;
// Exponential backoff factor used by downloadFile: delay = base * factor^attempt.
export const DOWNLOAD_RETRY_BACKOFF_FACTOR = 2;

// ── Server lifecycle ──

// Hard deadline for the `initialize` JSON-RPC round-trip. If the spawned
// server never replies (e.g. it crashed on startup but its stderr was
// swallowed, or it wrote garbage to stdout that vscode-jsonrpc is still
// trying to parse), we fail the session instead of hanging forever.
export const SERVER_INIT_TIMEOUT_MS = 30_000;

// Grace window after SIGTERM before escalating to SIGKILL. Gives the
// server a chance to flush logs and persist state, but bounded so a
// wedged server can't block app quit indefinitely.
export const SERVER_STOP_GRACE_MS = 3_000;

// Auto-restart policy: up to N attempts with exponential backoff.
// After exhausting retries the session flips to Failed and stays there
// until the user manually restarts.
export const SERVER_RESTART_MAX_ATTEMPTS = 3;
export const SERVER_RESTART_BASE_DELAY_MS = 1_000;

// Minimum ECA server version this client is known to work against.
// Bumped manually as the protocol evolves; a mismatch only produces a
// warning log today (not a hard failure) so users with older servers
// can still launch.
export const MIN_SERVER_VERSION = '0.0.0';
