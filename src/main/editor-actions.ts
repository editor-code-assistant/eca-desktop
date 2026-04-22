// ============================================================
// Editor actions — desktop-specific handlers (file, clipboard, URLs)
// ============================================================

import type { BrowserWindow} from 'electron';
import { dialog, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    parse as jsoncParse,
    printParseErrorCode,
    type ParseError,
} from 'jsonc-parser';
import { MIME_TO_EXTENSION, getGlobalConfigPath } from './constants';
import { isAllowedExternalUrl } from './security/url-allowlist';
import { isWithinRoots } from './security/path-scope';
import type {
    EditorOpenFileData,
    EditorOpenUrlData,
    EditorSaveFileData,
    EditorSaveClipboardImageData,
    EditorSaveClipboardImageResult,
    EditorReadGlobalConfigResult,
    EditorWriteGlobalConfigData,
    EditorWriteGlobalConfigResult,
} from './protocol';

export function openFile(data: EditorOpenFileData, workspaceRoots?: string[]): void {
    // Path-scope check: when the caller provided workspace roots, refuse
    // paths outside of them. Back-compat: when roots are omitted (e.g.
    // legacy callers that haven't been migrated) the original behavior
    // is preserved so we don't regress existing flows.
    if (workspaceRoots && workspaceRoots.length > 0) {
        if (!isWithinRoots(data.path, workspaceRoots)) {
            console.warn(
                '[EditorActions] openFile refused — path outside workspace roots:',
                data.path,
            );
            return;
        }
    }
    shell.openPath(data.path);
}

export function openUrl(data: EditorOpenUrlData): void {
    // Allowlist check — reject javascript:, file:, vscode:, and any
    // other non-http(s)/mailto scheme that could be weaponized via
    // `shell.openExternal`.
    if (!isAllowedExternalUrl(data.url)) {
        console.warn('[EditorActions] openUrl refused — disallowed scheme:', data.url);
        return;
    }
    shell.openExternal(data.url);
}

export async function saveFile(mainWindow: BrowserWindow, data: EditorSaveFileData): Promise<void> {
    const defaultName = data.defaultName || 'chat-export.md';
    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(os.homedir(), defaultName),
        filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, data.content, 'utf-8');
    }
}

// Cap clipboard image size at 20 MB after base64 decoding. Anything
// bigger is almost certainly a mis-paste (e.g. a huge buffer) rather
// than a legitimate screenshot, and writing it would waste disk/IPC.
const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1_048_576;

export function saveClipboardImage(data: EditorSaveClipboardImageData): EditorSaveClipboardImageResult | null {
    const { base64Data, mimeType, requestId } = data;
    const ext = MIME_TO_EXTENSION[mimeType] || 'png';
    const tmpPath = path.join(os.tmpdir(), `eca-screenshot-${Date.now()}.${ext}`);

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > MAX_CLIPBOARD_IMAGE_BYTES) {
        console.warn(
            `[EditorActions] saveClipboardImage refused — image too large (${buffer.length} bytes, max ${MAX_CLIPBOARD_IMAGE_BYTES})`,
        );
        return null;
    }

    try {
        fs.writeFileSync(tmpPath, buffer);
        return { requestId, path: tmpPath };
    } catch (err) {
        console.error('[EditorActions] Failed to save clipboard image:', err);
        return null;
    }
}

// ── ECA global config ──

const EMPTY_GLOBAL_CONFIG = '{}\n';

/**
 * Ensures the global config file exists. Creates parent dirs and seeds the
 * file with `{}` if missing, so `shell.openPath` and subsequent reads always
 * succeed. Returns the absolute path.
 */
function ensureGlobalConfigExists(): string {
    const configPath = getGlobalConfigPath();
    if (!fs.existsSync(configPath)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, EMPTY_GLOBAL_CONFIG, 'utf-8');
    }
    return configPath;
}

/**
 * Opens the ECA global config file in the OS-default editor. Creates the
 * file (seeded with `{}`) if missing so the OS does not error on a missing
 * path.
 */
export function openGlobalConfig(): void {
    try {
        const configPath = ensureGlobalConfigExists();
        shell.openPath(configPath).then((err) => {
            if (err) {
                console.error('[EditorActions] shell.openPath returned error:', err);
            }
        });
    } catch (err) {
        console.error('[EditorActions] openGlobalConfig failed:', err);
    }
}

/**
 * Reads the ECA global config file from disk. Never throws: if the file does
 * not exist yet, returns `{ contents: '', exists: false }` so the UI can seed
 * a blank editor without a scary error banner. A read error (EPERM, etc.)
 * is returned in `error`.
 */
export function readGlobalConfig(): EditorReadGlobalConfigResult {
    const configPath = getGlobalConfigPath();
    if (!fs.existsSync(configPath)) {
        return { contents: '', path: configPath, exists: false };
    }
    try {
        const contents = fs.readFileSync(configPath, 'utf-8');
        return { contents, path: configPath, exists: true };
    } catch (err) {
        console.error('[EditorActions] readGlobalConfig failed:', err);
        return {
            contents: '',
            path: configPath,
            exists: true,
            error: (err as Error).message,
        };
    }
}

/**
 * Writes the ECA global config file after validating that the contents
 * parse as JSONC (JSON with Comments — `//`, `/* … *\/`, and trailing
 * commas tolerated, matching what the ECA server accepts). Writes
 * atomically via a temp file + rename so a mid-write crash does not leave
 * a truncated file. On parse failure the file on disk is left untouched
 * and `{ ok: false, error }` is returned.
 */
// Hard cap on global-config size. 1 MB is wildly more than any
// realistic hand-authored JSONC config; rejecting here prevents a
// malicious renderer from wedging the main process into writing an
// oversized file.
const MAX_GLOBAL_CONFIG_BYTES = 1_048_576;

export function writeGlobalConfig(data: EditorWriteGlobalConfigData): EditorWriteGlobalConfigResult {
    if (Buffer.byteLength(data.contents, 'utf-8') > MAX_GLOBAL_CONFIG_BYTES) {
        return { ok: false, error: 'Config file too large (max 1MB)' };
    }

    const errors: ParseError[] = [];
    jsoncParse(data.contents, errors, {
        allowTrailingComma: true,
        allowEmptyContent: true,
    });
    if (errors.length > 0) {
        const first = errors[0];
        return {
            ok: false,
            error: `Invalid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
        };
    }

    const configPath = getGlobalConfigPath();
    try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpPath, data.contents, 'utf-8');
        fs.renameSync(tmpPath, configPath);
        return { ok: true, path: configPath };
    } catch (err) {
        console.error('[EditorActions] writeGlobalConfig failed:', err);
        return { ok: false, error: (err as Error).message };
    }
}
