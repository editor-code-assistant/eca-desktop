import type { BrowserWindow} from 'electron';
import { app, dialog, net, shell } from 'electron';
import { autoUpdater } from 'electron-updater';

import {
    DESKTOP_LATEST_RELEASE_API,
    DESKTOP_LATEST_RELEASE_URL,
    HTTP_TIMEOUT_MS,
    USER_AGENT,
} from './constants';
import { isFlatpak } from './flatpak';
import { compareVersions } from './version';

/**
 * True when running from electron-builder's portable Windows exe. Its
 * launcher extracts the app into a fresh %TEMP% dir on every launch,
 * runs it from there, and exports PORTABLE_EXECUTABLE_FILE (the .exe
 * the user actually clicked) to the app's environment.
 */
export function isPortableWindowsBuild(): boolean {
    return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
}

export function setupAutoUpdater(mainWindow: BrowserWindow) {
    // Flatpak owns app updates (`flatpak update` / software centers);
    // electron-updater has no Flatpak support and would try to replace
    // files inside the read-only /app mount. The managed ECA *server*
    // binary in ~/.eca-desktop keeps auto-updating independently (see
    // server.ts ensureServer).
    if (isFlatpak()) {
        console.log('[Updater] Flatpak detected — app updates are handled by Flatpak; skipping electron-updater.');
        return;
    }

    // The portable exe can't be updated in place: the running copy is a
    // throwaway extraction, and electron-builder publishes no latest.yml
    // for the portable target, so electron-updater would only error out.
    // Tell the user about new releases instead. The managed ECA server
    // keeps auto-updating as on every other platform.
    if (isPortableWindowsBuild()) {
        console.log('[Updater] Portable Windows build — electron-updater unsupported; checking GitHub for a newer release instead.');
        void notifyIfNewerRelease(mainWindow);
        return;
    }

    // Configure auto-updater
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `A new version (${info.version}) of ECA Desktop is available.`,
            detail: 'Would you like to download it now?',
            buttons: ['Download', 'Later'],
            defaultId: 0,
        }).then(({ response }) => {
            if (response === 0) {
                autoUpdater.downloadUpdate();
            }
        });
    });

    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Ready',
            message: 'Update has been downloaded. The application will restart to apply the update.',
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
        }).then(({ response }) => {
            if (response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });

    autoUpdater.on('error', (err) => {
        console.error('[Updater] Error:', err);
    });

    // Check for updates (silently, don't show dialog if no update)
    autoUpdater.checkForUpdates().catch((err) => {
        console.error('[Updater] Failed to check for updates:', err);
    });
}

/**
 * Update notice for builds electron-updater can't update in place. Asks
 * GitHub for the latest published desktop release and, when it is newer
 * than the running app, offers to open its download page in the browser.
 *
 * Best-effort: never rejects. Network/API failures are only logged — an
 * update check must never get in the way of using the app.
 */
export async function notifyIfNewerRelease(mainWindow: BrowserWindow): Promise<void> {
    try {
        // net.fetch (Chromium's network stack) rather than Node's https:
        // it honors the OS proxy settings, common on corporate Windows.
        const res = await net.fetch(DESKTOP_LATEST_RELEASE_API, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
            console.error(`[Updater] Latest-release check failed: HTTP ${res.status}`);
            return;
        }
        const body: unknown = await res.json();
        const tag = typeof body === 'object' && body !== null
            ? (body as { tag_name?: unknown }).tag_name
            : undefined;
        if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+/.test(tag)) {
            console.error('[Updater] Latest-release check returned an unexpected tag:', tag);
            return;
        }
        const latest = tag.replace(/^v/, '');
        const current = app.getVersion();
        if (compareVersions(latest, current) <= 0) {
            console.log(`[Updater] Up to date (running ${current}, latest release ${latest}).`);
            return;
        }
        // The check is async; the user may have closed the window meanwhile.
        if (mainWindow.isDestroyed()) return;

        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Available',
            message: `A new version (${latest}) of ECA Desktop is available.`,
            detail: 'This portable build can\'t update itself. Download the new eca-win-x64.exe from the release page and use it instead of this one.',
            buttons: ['Open Download Page', 'Later'],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0) {
            await shell.openExternal(DESKTOP_LATEST_RELEASE_URL);
        }
    } catch (err) {
        console.error('[Updater] Failed to check for a newer release:', err);
    }
}
