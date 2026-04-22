import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { createBridge } from './bridge';
import { getLogStore } from './log-store';
import { createMenu } from './menu';
import { setupAutoUpdater } from './updater';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';
import type { Preferences} from './preferences-store';
import { PreferencesStore, isValidTheme } from './preferences-store';
import { getPreferencesWindow } from './preferences-window';
import type { WorkspaceFolder } from './protocol';

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

// macOS toolbar constants — traffic lights are vertically centered within
// this height.  The same value is used in the renderer (CSS custom property
// --toolbar-h) to position the sidebar toggle button at the same level.
const TOOLBAR_HEIGHT = 38;           // px – height of our custom toolbar zone
const TRAFFIC_LIGHTS_HEIGHT = 16;    // px – native macOS button height

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 500,
    minHeight: 400,
    // 'hidden' (not 'hiddenInset') gives full control over traffic-light
    // positioning without the extra OS-applied inset offset.
    titleBarStyle: 'hidden',
    trafficLightPosition: {
      x: 15,
      y: Math.floor((TOOLBAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2),
    },
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

  // Initialize the log store BEFORE the session manager so the earliest
  // server-lifecycle messages (download, version check, start errors)
  // are captured. The store is safe to access after app.whenReady().
  const logStore = getLogStore();

  // Stream every new log entry to the webview as a `server-message` so
  // the Logs tab can render them live. `server-message` is already the
  // existing fan-out channel consumed by eca-webview via `useWebviewListener`
  // (see eca-webview/src/pages/RootWrapper.tsx).
  logStore.subscribe((entry) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-message', {
        type: 'logs/appended',
        data: entry,
      });
    }
  });

  createMenu(mainWindow);

  const sessionManager = new SessionManager(preferencesStore);
  const sessionStore = new SessionStore();
  const bridge = createBridge(mainWindow, sessionManager);

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
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not stat file' };
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

  // ── Sidebar collapse ──
  function toggleSidebarCollapse(): void {
    const current = preferencesStore.get().sidebarCollapsed ?? false;
    const next = !current;
    preferencesStore.set({ sidebarCollapsed: next });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('sidebar-collapse-changed', { collapsed: next });
      }
    }
  }

  ipcMain.on('sidebar-collapse-toggle', () => {
    toggleSidebarCollapse();
  });

  // Expose for the menu accelerator (View > Toggle Sidebar)
  (global as any).__ecaToggleSidebarCollapse = toggleSidebarCollapse;

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('welcome-data', {
      recentWorkspaces: sessionStore.getRecents(),
    });
    // Send initial sidebar collapse state so the renderer can apply it before first paint
    const collapsed = preferencesStore.get().sidebarCollapsed ?? false;
    mainWindow.webContents.send('sidebar-collapse-changed', { collapsed });
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

    // Register the status listener BEFORE starting so the very first
    // setStatus(Starting) inside `start()` reaches the renderer. This
    // inline listener is overwritten by bridge.registerServerNotifications
    // below (invoked via onConnectionReady from within `start()` itself);
    // both versions behave identically so the hand-off is seamless.
    session.ecaServer.onStatusChanged = (status) => {
      if (session.id === sessionManager.activeSessionId) {
        mainWindow.webContents.send('server-message', {
          type: 'server/statusChanged',
          data: status,
        });
      }
      bridge.sendSessionListUpdate();
    };

    // Register JSON-RPC notification handlers the moment the connection
    // is live — BEFORE `initialize` is sent. The ECA server emits
    // `$/progress` (plus a burst of `config/updated`, `tool/serverUpdated`,
    // `providers/updated`, etc.) from inside its `initialized` handler;
    // handlers registered after `start()` resolves miss those events
    // because vscode-jsonrpc drops notifications with no handler at the
    // time of arrival (no buffering, no replay). See
    // EcaServer.onConnectionReady for the full rationale.
    session.ecaServer.onConnectionReady = () => {
      bridge.registerServerNotifications(session);
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
      // `start()` resolves once `initialize` has round-tripped AND
      // `initialized` has been sent — at which point the server has
      // rehydrated its persisted chats from disk and is safe to answer
      // `chat/list`. Server status on resolve is either `Initializing`
      // (post-init async work still running) or `Running` (fast path /
      // no progress emitted at all). All notification handlers were
      // already wired via the `onConnectionReady` hook above, so there
      // is intentionally no post-start register call here.
      await session.ecaServer.start([workspaceFolder]);

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
