import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'path';
import * as fs from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
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
import { sanitizeExternalUrl } from './security/url-allowlist';

// Canonical Electron idiom: `app.isPackaged` is true only in production
// builds (electron-builder output). Switching from `NODE_ENV==='development'`
// fixes the dev-mode regression where the `"dev"` npm script never exports
// NODE_ENV and thus lost dev-only affordances (DevTools menu, etc.).
// See code-review M-1.
const IS_DEV = !app.isPackaged;
const WEBVIEW_DEV_URL = 'http://localhost:5173';

// Whether to load the webview from a live Vite dev server (`vite dev`,
// default port 5173) instead of the on-disk `file://` build. Opt-in via
// `ECA_DEV_SERVER=1` because the stock `npm run dev` flow uses
// `vite build --watch` (writes to disk + our fs.watch reloads the window)
// — no HTTP server is running on 5173, so loading the URL would error
// with ERR_CONNECTION_REFUSED. Users who want true HMR can run
// `cd eca-webview && npx vite` in a second terminal and start the app
// with `ECA_DEV_SERVER=1 npm run dev`.
const USE_DEV_SERVER = IS_DEV && process.env.ECA_DEV_SERVER === '1';

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
  const isMac = process.platform === 'darwin';
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 500,
    minHeight: 400,
    // macOS: use 'hidden' (not 'hiddenInset') to get full control over
    // traffic-light positioning without the extra OS-applied inset offset.
    // Linux/Windows: keep the native chrome ('default') so the native
    // application menu bar (File, View, About, ...) remains visible.
    titleBarStyle: isMac ? 'hidden' : 'default',
    // trafficLightPosition is a macOS-only option; gate it explicitly
    // instead of relying on Electron to ignore it on other platforms.
    ...(isMac
      ? {
          trafficLightPosition: {
            x: 15,
            y: Math.floor((TOOLBAR_HEIGHT - TRAFFIC_LIGHTS_HEIGHT) / 2),
          },
        }
      : {}),
    frame: isMac ? false : true,
    backgroundColor: '#0c0c0c',
    icon: path.join(__dirname, '../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox the renderer: any compromise in the webview bundle can
      // no longer access full Node via the preload context. See audit
      // finding C1. Preload uses only contextBridge + ipcRenderer, both
      // of which remain available under sandbox.
      sandbox: true,
      // Asserted explicitly instead of relying on the Electron 33
      // default (defensive against future default changes).
      webSecurity: true,
    },
  });

  if (USE_DEV_SERVER) {
    mainWindow.loadURL(WEBVIEW_DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  }

  // Open external links in the default browser — but only allowlisted
  // schemes (http/https/mailto). Without this filter the webview could
  // trigger shell.openExternal against javascript:, file:, vscode: or
  // arbitrary custom URL handlers. See audit finding C3.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safe = sanitizeExternalUrl(url);
    if (safe) {
      shell.openExternal(safe).catch((err) => {
        console.warn('[Main] shell.openExternal failed:', err);
      });
    } else {
      console.warn('[Main] Blocked window-open with disallowed URL:', url);
    }
    return { action: 'deny' };
  });

  // Block all in-window navigation away from the app origin. Combined
  // with the window-open allowlist above this covers both `target=_blank`
  // (setWindowOpenHandler) and link clicks / location.href assignments
  // (will-navigate). Audit finding H1.
  const allowedOrigins = new Set<string>();
  if (USE_DEV_SERVER) allowedOrigins.add(new URL(WEBVIEW_DEV_URL).origin);
  // Production uses file:// — navigations within file:// are usually
  // harmless but we still deny hop-off to other origins.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const isFileProto = target.protocol === 'file:';
      const isAllowedOrigin = allowedOrigins.has(target.origin);
      if (!isFileProto && !isAllowedOrigin) {
        event.preventDefault();
        console.warn('[Main] Blocked will-navigate to:', url);
      }
    } catch {
      event.preventDefault();
    }
  });

  return mainWindow;
}

async function main(): Promise<void> {
  await app.whenReady();

  // Deny every permission request by default (notifications, media,
  // geolocation, etc.). The ECA desktop app has no legitimate need for
  // any of these; silently-granted permissions are a common Electron
  // foot-gun. Audit finding H2.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  // Inject a Content-Security-Policy header for loaded resources — the
  // <meta> tag in index.html doesn't apply to the dev Vite URL, and
  // header-level CSP is harder to bypass via content injection. Keeping
  // 'unsafe-inline' on style-src is intentional (React inline styles);
  // script-src is locked to 'self'. Audit finding C2.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url;
    // Only intercept our own resources. External origins (docs, provider
    // login flows) are opened in the OS browser via shell.openExternal.
    // Keep the match tight to avoid injecting our CSP onto unrelated
    // localhost services the user may have running. See code-review M-3.
    // The dev-server branch is only active when the user explicitly
    // opts in via ECA_DEV_SERVER=1 (see top of file).
    const shouldInject =
      url.startsWith('file://')
      || (USE_DEV_SERVER && url.startsWith(WEBVIEW_DEV_URL));
    if (!shouldInject) return callback({});
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; "
          + "script-src 'self'; "
          + "style-src 'self' 'unsafe-inline'; "
          + "img-src 'self' data: blob:; "
          + "font-src 'self' data:; "
          + "connect-src 'self' ws://localhost:* http://localhost:*; "
          + "object-src 'none'; "
          + "base-uri 'self';",
        ],
      },
    });
  });

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
      // Direct URI provided (from recent workspaces). Use fileURLToPath
      // so paths with spaces / unicode decode correctly — `new URL(uri).pathname`
      // leaves percent-encoded bytes in place which breaks fs operations on
      // e.g. `/home/user/My Code` → `/home/user/My%20Code`. Audit finding
      // "new URL(uri).pathname is percent-encoded".
      try {
        folderPath = fileURLToPath(data.uri);
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

  ipcMain.on('session-remove', async (_event, data: { sessionId: string }) => {
    // Notify renderer to clear each chat in this session before destroying it
    const existing = sessionManager.getSession(data.sessionId);
    if (existing) {
      const { entries } = existing.chatState.getChatListUpdate();
      for (const entry of entries) {
        mainWindow.webContents.send('server-message', {
          type: 'chat/deleted',
          data: entry.id,
        });
      }
    }

    // `removeSession` now awaits the server's graceful stop (with SIGKILL
    // escalation). Awaiting here keeps the UI update in-order so the
    // sidebar never flashes a half-stopped session.
    await sessionManager.removeSession(data.sessionId);
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

  // Dev mode: watch renderer + webview dist files and auto-reload the window.
  //
  // NB: `fs.watch(dir, { recursive: true })` is not supported on Linux and
  // throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` on recent Node versions,
  // so the original implementation broke live-reload for Linux developers.
  // We now walk the renderer directory and watch each subdirectory
  // individually, which works uniformly across macOS / Linux / Windows
  // without adding a chokidar dependency to the runtime bundle.
  if (!app.isPackaged) {
    const fs = require('fs');
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const activeWatchers: Array<ReturnType<typeof fs.watch>> = [];

    const scheduleReload = (source: string, filename: string) => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log(`[Dev] ${source} file changed: ${filename}, reloading…`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      }, 500);
    };

    const watchDirNonRecursive = (dir: string, source: string, filter?: (f: string) => boolean): void => {
      try {
        const watcher = fs.watch(dir, (_event: string, filename: string | null) => {
          if (!filename) return;
          if (filter && !filter(filename)) return;
          scheduleReload(source, filename);
        });
        activeWatchers.push(watcher);
      } catch (err) {
        console.warn(`[Dev] Could not watch ${dir}:`, err);
      }
    };

    const walkAndWatch = (root: string, source: string, filter?: (f: string) => boolean): void => {
      const visit = (dir: string): void => {
        watchDirNonRecursive(dir, source, filter);
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            visit(path.join(dir, entry.name));
          }
        }
      };
      visit(root);
    };

    // Watch renderer files (sidebar, welcome, theme, index.html, bootstraps).
    const rendererDir = path.join(__dirname, '../src/renderer');
    walkAndWatch(rendererDir, 'Renderer');

    // Watch webview dist (vite build --watch output) — non-recursive is fine,
    // vite writes everything to a single `assets/` directory.
    const webviewDistDir = path.join(__dirname, '../eca-webview/dist/assets');
    watchDirNonRecursive(webviewDistDir, 'Webview', (f) => f.endsWith('.js') || f.endsWith('.css'));

    // Tear down on window close so we don't leak watchers when the
    // window is recreated via `activate`.
    app.on('before-quit', () => {
      for (const w of activeWatchers) {
        try { w.close(); } catch { /* noop */ }
      }
    });

    console.log('[Dev] Watching renderer + webview files for live reload');
  }

  // Graceful shutdown of every ECA server before the app exits.
  //
  // Electron's `before-quit` is synchronous from the event loop's
  // perspective: an unawaited async handler lets the process exit while
  // JSON-RPC `shutdown`/`exit` is still in flight, leaving the spawned
  // `eca` child as an orphan. We `event.preventDefault()`, await every
  // session's stop() (with its own SIGKILL escalation), and only then
  // call `app.exit()` to actually terminate. See audit finding S4.
  let quittingCleanly = false;
  app.on('before-quit', (event) => {
    if (quittingCleanly) return; // allow the final app.exit() to proceed
    event.preventDefault();
    quittingCleanly = true;
    const OVERALL_QUIT_DEADLINE_MS = 8_000;
    const stops = sessionManager.getAllSessions().map(
      (s) => s.ecaServer.stop().catch((err) => {
        console.error('[Main] Error stopping session on quit:', err);
      }),
    );
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, OVERALL_QUIT_DEADLINE_MS),
    );
    Promise.race([Promise.all(stops).then(() => undefined), deadline]).then(() => {
      app.exit(0);
    });
  });
}

main().catch(console.error);
