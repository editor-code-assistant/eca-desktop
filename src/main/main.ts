import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
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

  const ecaServer = new EcaServer();
  const bridge = createBridge(mainWindow, ecaServer);

  try {
    await ecaServer.start();
    bridge.registerServerNotifications();
  } catch (err) {
    console.error('[Main] Failed to start ECA server:', err);
  }

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  if (!IS_DEV) {
    setupAutoUpdater(mainWindow);
  }

  app.on('before-quit', async () => {
    await ecaServer.stop();
  });
}

main().catch(console.error);
