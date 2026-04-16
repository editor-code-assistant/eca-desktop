import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import { createBridge } from './bridge';
import { createMenu } from './menu';
import { setupAutoUpdater } from './updater';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';
import { WorkspaceFolder } from './protocol';

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
    backgroundColor: '#0c0c0c',
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

  const sessionManager = new SessionManager();
  const sessionStore = new SessionStore();
  const bridge = createBridge(mainWindow, sessionManager, sessionStore);

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('welcome-data', {
      recentWorkspaces: sessionStore.getRecents(),
    });
  });

  ipcMain.on('session-create', async (_event, data: { uri?: string }) => {
    let folderPath: string | undefined;

    if (data?.uri) {
      // Direct URI provided (from recent workspaces)
      try {
        folderPath = new URL(data.uri).pathname;
      } catch {
        folderPath = data.uri;
      }
    } else {
      // Open folder picker dialog
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Workspace Folder',
      });
      if (result.canceled || result.filePaths.length === 0) return;
      folderPath = result.filePaths[0];
    }

    if (!folderPath) return;

    const workspaceFolder: WorkspaceFolder = {
      name: path.basename(folderPath),
      uri: pathToFileURL(folderPath).href,
    };

    // Check if session already exists for this workspace
    const existing = sessionManager.getAllSessions().find(
      s => s.workspaceFolder.uri === workspaceFolder.uri
    );
    if (existing) {
      sessionManager.activeSessionId = existing.id;
      bridge.sendSessionListUpdate();
      return;
    }

    const session = sessionManager.createSession(workspaceFolder);
    sessionManager.activeSessionId = session.id;
    sessionStore.addRecent({ uri: workspaceFolder.uri, name: workspaceFolder.name });

    // Register notifications BEFORE starting so we capture status transitions
    session.ecaServer.onStatusChanged = (status) => {
      if (session.id === sessionManager.activeSessionId) {
        mainWindow.webContents.send('server-message', {
          type: 'server/statusChanged',
          data: status,
        });
      }
      bridge.sendSessionListUpdate();
    };

    bridge.sendSessionListUpdate();

    // Switch webview to a fresh chat for the new session
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-message', {
        type: 'chat/createNewChat',
        data: {},
      });
    }

    try {
      await session.ecaServer.start([workspaceFolder]);
      bridge.registerServerNotifications(session);

      // Server is now Running — send status + workspace to renderer
      // (the webview/ready message was already handled before this session existed)
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('server-message', {
          type: 'server/statusChanged',
          data: session.ecaServer.status,
        });
        mainWindow.webContents.send('server-message', {
          type: 'server/setWorkspaceFolders',
          data: [session.workspaceFolder],
        });
      }
    } catch (err) {
      console.error('[Main] Failed to start ECA server for session:', err);
    }

    bridge.sendSessionListUpdate();
  });

  ipcMain.on('session-remove', (_event, data: { sessionId: string }) => {
    // Notify renderer to clear each chat in this session before destroying it
    const session = sessionManager.getSession(data.sessionId);
    if (session) {
      const { entries } = session.chatState.getChatListUpdate();
      for (const entry of entries) {
        mainWindow.webContents.send('server-message', {
          type: 'chat/deleted',
          data: entry.id,
        });
      }
    }

    sessionManager.removeSession(data.sessionId);
    bridge.sendSessionListUpdate();
    bridge.sendChatListUpdate();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
      createMenu(newWindow);
      // Bridge and sessions are managed separately
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
    for (const session of sessionManager.getAllSessions()) {
      await session.ecaServer.stop();
    }
  });
}

main().catch(console.error);
