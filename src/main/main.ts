import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { createBridge } from './bridge';
import { createMenu } from './menu';
import { setupAutoUpdater } from './updater';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';
import { PreferencesStore, Preferences, isValidTheme } from './preferences-store';
import { getPreferencesWindow } from './preferences-window';
import { WorkspaceFolder } from './protocol';

const IS_DEV = process.env.NODE_ENV === 'development';
const WEBVIEW_DEV_URL = 'http://localhost:5173';

// Set the application name explicitly so macOS shows "ECA" in the menu bar,
// dock, and About dialog instead of the default "Electron" during development.
app.name = 'ECA';

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

  // On macOS, the dock icon in dev mode defaults to the Electron logo.
  // Explicitly set it to the ECA icon so it matches production builds.
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '../resources/icon.png'));
  }

  const mainWindow = createWindow();

  const preferencesStore = new PreferencesStore();

  createMenu(mainWindow);

  const sessionManager = new SessionManager(preferencesStore);
  const sessionStore = new SessionStore();
  const bridge = createBridge(mainWindow, sessionManager, sessionStore);

  // ── Preferences IPC (request/response) ──
  ipcMain.handle('preferences:get', (): Preferences => preferencesStore.get());

  ipcMain.handle('preferences:set', (_event, patch: Partial<Preferences>) => {
    // Validate server binary path before persisting.
    if (patch && typeof patch.serverBinaryPath === 'string' && patch.serverBinaryPath.trim() !== '') {
      const candidate = patch.serverBinaryPath.trim();
      if (!fs.existsSync(candidate)) {
        return { ok: false, error: `File does not exist: ${candidate}` };
      }
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
          return { ok: false, error: `Not a regular file: ${candidate}` };
        }
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'Could not stat file' };
      }
      if (process.platform !== 'win32') {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch {
          return { ok: false, error: `File is not executable: ${candidate}` };
        }
      }
    }

    // Validate theme value when provided.
    if (patch && patch.theme !== undefined && !isValidTheme(patch.theme)) {
      return { ok: false, error: `Invalid theme: ${String(patch.theme)}` };
    }

    const preferences = preferencesStore.set(patch);

    // Broadcast to every open window so any watcher can refresh.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('preferences-updated', preferences);
      }
    }

    return { ok: true, preferences };
  });

  ipcMain.handle('preferences:pick-binary', async () => {
    const parent = getPreferencesWindow() ?? mainWindow;
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      title: 'Select ECA server binary',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

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
      // `start()` only resolves after the server has processed `initialize`
      // AND the client has sent `initialized` — which is exactly when the
      // server has rehydrated its persisted chats from disk and is safe to
      // answer `chat/list`.
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

      // Fetch the persisted chat list so the sidebar reflects prior work in
      // this workspace. Must happen after notifications are registered so any
      // follow-up server events (e.g. from a user clicking one of the loaded
      // entries) are delivered through the existing handlers.
      await bridge.loadSessionChats(session);
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

  // Dev mode: watch renderer + webview dist files and auto-reload the window
  if (!app.isPackaged) {
    const fs = require('fs');
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReload = (source: string, filename: string) => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log(`[Dev] ${source} file changed: ${filename}, reloading…`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      }, 500);
    };

    // Watch renderer files (sidebar, welcome, theme, index.html)
    const rendererDir = path.join(__dirname, '../src/renderer');
    fs.watch(rendererDir, { recursive: true }, (_event: string, filename: string) => {
      if (!filename) return;
      scheduleReload('Renderer', filename);
    });

    // Watch webview dist (vite build --watch output)
    const webviewDistDir = path.join(__dirname, '../eca-webview/dist/assets');
    fs.watch(webviewDistDir, (_event: string, filename: string) => {
      if (!filename) return;
      // Only reload on JS/CSS changes, not intermediate files
      if (filename.endsWith('.js') || filename.endsWith('.css')) {
        scheduleReload('Webview', filename);
      }
    });

    console.log('[Dev] Watching renderer + webview files for live reload');
  }

  app.on('before-quit', async () => {
    for (const session of sessionManager.getAllSessions()) {
      await session.ecaServer.stop();
    }
  });
}

main().catch(console.error);
