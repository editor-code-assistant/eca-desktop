import type { BrowserWindow} from 'electron';
import { dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

import { isFlatpak } from './flatpak';

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
