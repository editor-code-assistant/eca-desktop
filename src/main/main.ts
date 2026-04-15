import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { EcaServer } from './server';
import { createBridge } from './bridge';
import { createMenu } from './menu';
import { setupAutoUpdater } from './updater';

const IS_DEV = process.env.NODE_ENV === 'development';
const WEBVIEW_DEV_URL = 'http://localhost:5173';

// On Linux without proper GPU drivers (e.g. VMs, some Wayland compositors),
// hardware acceleration can crash the GPU process. Detect and disable if needed.
if (process.platform === 'linux' && process.env.ECA_DISABLE_GPU) {
  app.disableHardwareAcceleration();
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 500,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    frame: process.platform === 'darwin' ? false : true,
    backgroundColor: '#1e1e2e',
    icon: path.join(__dirname, '../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (IS_DEV) {
    mainWindow.loadURL(WEBVIEW_DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  }

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

async function main(): Promise<void> {
  await app.whenReady();

  const mainWindow = createWindow();

  createMenu(mainWindow);

  const cwd = process.cwd();
  const workspaceFolders = [{ name: path.basename(cwd), uri: pathToFileURL(cwd).href }];

  const ecaServer = new EcaServer();
  const bridge = createBridge(mainWindow, ecaServer, workspaceFolders);

  try {
    await ecaServer.start(workspaceFolders);
    bridge.registerServerNotifications();
  } catch (err) {
    console.error('[Main] Failed to start ECA server:', err);
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
      createMenu(newWindow);
      const newBridge = createBridge(newWindow, ecaServer, workspaceFolders);
      ecaServer.start(workspaceFolders).then(() => {
        newBridge.registerServerNotifications();
      }).catch(err => {
        console.error('[Main] Failed to restart ECA server on activate:', err);
      });
    }
  });

  if (!IS_DEV) {
    setupAutoUpdater(mainWindow);
  }

  // Dev mode: watch renderer files and auto-reload the window
  if (!app.isPackaged) {
    const fs = require('fs');
    const rendererDir = path.join(__dirname, '../src/renderer');
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    fs.watch(rendererDir, { recursive: true }, (_event: string, filename: string) => {
      if (!filename) return;
      // Debounce: multiple changes fire rapidly, reload once
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log(`[Dev] Renderer file changed: ${filename}, reloading…`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      }, 300);
    });
    console.log('[Dev] Watching renderer files for live reload');
  }

  app.on('before-quit', async () => {
    await ecaServer.stop();
  });
}

main().catch(console.error);
