// ============================================================
// Preferences window — dedicated BrowserWindow for user prefs
// ============================================================

import { BrowserWindow } from 'electron';
import path from 'path';

const IS_DEV = process.env.NODE_ENV === 'development';

let prefsWindow: BrowserWindow | null = null;

/**
 * Open the preferences window, or focus it if already open.
 * Maintains a single-window singleton.
 */
export function openPreferencesWindow(parent?: BrowserWindow): BrowserWindow {
    if (prefsWindow && !prefsWindow.isDestroyed()) {
        if (prefsWindow.isMinimized()) prefsWindow.restore();
        prefsWindow.focus();
        return prefsWindow;
    }

    prefsWindow = new BrowserWindow({
        width: 720,
        height: 540,
        minWidth: 560,
        minHeight: 420,
        title: 'Preferences',
        parent,
        modal: false,
        resizable: true,
        minimizable: false,
        maximizable: false,
        backgroundColor: '#0c0c0c',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        trafficLightPosition: { x: 12, y: 12 },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // Plain static HTML — no webview / vite involvement, so the same file
    // path works in dev and prod.
    prefsWindow.loadFile(path.join(__dirname, '../src/renderer/preferences.html'));

    prefsWindow.on('closed', () => {
        prefsWindow = null;
    });

    if (IS_DEV) {
        prefsWindow.webContents.openDevTools({ mode: 'detach' });
    }

    return prefsWindow;
}

/** Returns the live preferences window, or null if it is closed. */
export function getPreferencesWindow(): BrowserWindow | null {
    return prefsWindow && !prefsWindow.isDestroyed() ? prefsWindow : null;
}
