// ============================================================
// Shared constants — extracted from across the codebase
// ============================================================

import * as path from 'path';
import * as os from 'os';

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
    const fs = require('fs') as typeof import('fs');
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
 *      - darwin:  `~/Library/Application Support/eca/config.json`
 *      - win32:   `%APPDATA%\eca\config.json` (falls back to `~/.config/eca/config.json`)
 *      - others:  `~/.config/eca/config.json`
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

    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'eca', 'config.json');
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
export const DOWNLOAD_MAX_RETRIES = 1;
export const DOWNLOAD_RETRY_DELAY_MS = 2_000;
