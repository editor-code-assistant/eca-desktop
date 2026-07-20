// ============================================================
// Input dialog — modal prompt window for editor/readInput
// ============================================================
//
// Electron has no native input prompt (dialog.showMessageBox only does
// buttons), so `editor/readInput` — used by the webview for provider
// login flows (choose method / enter API key) and prompt-command args —
// is served by a small modal BrowserWindow that renders a themed input
// or option list and reports the result back over IPC.
//
// Protocol (renderer side lives in src/renderer/input-dialog.ts):
//   1. main creates the modal window and stores its sanitized config
//      keyed by webContents.id
//   2. dialog page invokes 'input-dialog:get-config' to fetch it
//   3. dialog page sends 'input-dialog:submit' with the value
//      (string, or null on cancel); closing the window without
//      submitting also resolves null.

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';

export interface InputDialogOptions {
    /** Prompt title shown in the dialog (and window title). */
    title?: string;
    /** Placeholder for the text input mode. */
    placeholder?: string;
    /** When present and non-empty, renders a pick list instead of an input. */
    options?: string[];
    /** Mask the typed value (API keys, tokens, …). */
    password?: boolean;
}

/** Sanitized config actually handed to the dialog renderer. */
export interface InputDialogConfig {
    title: string;
    placeholder: string;
    options: string[];
    password: boolean;
}

// Cap the option-list length defensively: the payload originates from
// the ECA server's login methods (a handful of entries), so anything
// huge is malformed and would only produce a comically tall window.
const MAX_OPTIONS = 20;
const MAX_TEXT_LEN = 200;

/**
 * Coerces the raw (webview-supplied) payload into a safe, fully-populated
 * config. Non-string entries are dropped rather than stringified so a
 * malformed payload cannot smuggle objects into the dialog DOM.
 */
export function sanitizeInputDialogOptions(opts: InputDialogOptions): InputDialogConfig {
    const clip = (s: unknown, fallback: string): string =>
        typeof s === 'string' && s.length > 0 ? s.slice(0, MAX_TEXT_LEN) : fallback;

    const options = Array.isArray(opts.options)
        ? opts.options
            .filter((o): o is string => typeof o === 'string')
            .slice(0, MAX_OPTIONS)
            .map((o) => o.slice(0, MAX_TEXT_LEN))
        : [];

    return {
        title: clip(opts.title, 'Input required'),
        placeholder: clip(opts.placeholder, ''),
        options,
        password: opts.password === true,
    };
}

interface PendingDialog {
    config: InputDialogConfig;
    resolve: (value: string | null) => void;
    resolved: boolean;
}

// Keyed by the dialog window's webContents.id — supports (unlikely but
// possible) concurrent dialogs from different flows without cross-talk.
const pendingDialogs = new Map<number, PendingDialog>();

let ipcRegistered = false;

function ensureIpcHandlers(): void {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle('input-dialog:get-config', (event): InputDialogConfig | null => {
        return pendingDialogs.get(event.sender.id)?.config ?? null;
    });

    ipcMain.on('input-dialog:submit', (event, value: unknown) => {
        const pending = pendingDialogs.get(event.sender.id);
        if (!pending || pending.resolved) return;
        pending.resolved = true;
        pending.resolve(typeof value === 'string' ? value : null);
        // Close the window; the 'closed' handler performs map cleanup.
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.close();
    });
}

// Base chrome + prompt label; option rows / the input add to this.
const BASE_HEIGHT = 132;
const OPTION_ROW_HEIGHT = 40;
const INPUT_HEIGHT = 40;
const MAX_HEIGHT = 520;

/**
 * Shows a modal input dialog attached to `parent` and resolves with the
 * submitted string, or `null` when cancelled (Escape, Cancel button, or
 * window closed).
 */
export function showInputDialog(
    parent: BrowserWindow | undefined,
    opts: InputDialogOptions,
): Promise<string | null> {
    ensureIpcHandlers();

    const config = sanitizeInputDialogOptions(opts);

    const contentHeight = Math.min(
        MAX_HEIGHT,
        BASE_HEIGHT + (config.options.length > 0
            ? config.options.length * OPTION_ROW_HEIGHT
            : INPUT_HEIGHT),
    );

    const usableParent = parent && !parent.isDestroyed() ? parent : undefined;

    const win = new BrowserWindow({
        width: 460,
        height: contentHeight,
        useContentSize: true,
        title: config.title,
        parent: usableParent,
        modal: usableParent !== undefined,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        backgroundColor: '#0c0c0c',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });
    win.setMenuBarVisibility(false);

    // Capture the id now: by the time 'closed' fires, win.webContents is
    // already destroyed and even reading `.id` on it throws
    // "TypeError: Object has been destroyed".
    const contentsId = win.webContents.id;

    return new Promise<string | null>((resolve) => {
        pendingDialogs.set(contentsId, { config, resolve, resolved: false });

        win.on('closed', () => {
            const pending = pendingDialogs.get(contentsId);
            pendingDialogs.delete(contentsId);
            if (pending && !pending.resolved) {
                pending.resolved = true;
                pending.resolve(null);
            }
        });

        win.once('ready-to-show', () => {
            if (!win.isDestroyed()) win.show();
        });

        // Same static-HTML pattern as the preferences window: the file
        // lives in src/renderer next to its esbuild-bundled JS, valid in
        // both dev and packaged builds.
        win.loadFile(path.join(__dirname, '../src/renderer/input-dialog.html'))
            .catch((err) => {
                console.error('[InputDialog] Failed to load dialog page:', err);
                if (!win.isDestroyed()) win.close();
            });
    });
}

// Test hook: allows unit tests to reset module-level IPC registration
// state without reloading the module registry.
export function __resetForTests(): void {
    if (ipcRegistered) {
        ipcMain.removeHandler('input-dialog:get-config');
        ipcMain.removeAllListeners('input-dialog:submit');
        ipcRegistered = false;
    }
    pendingDialogs.clear();
}

// Ensure dangling dialogs don't keep the app alive on quit.
app?.on?.('before-quit', () => {
    for (const pending of pendingDialogs.values()) {
        if (!pending.resolved) {
            pending.resolved = true;
            pending.resolve(null);
        }
    }
    pendingDialogs.clear();
});
