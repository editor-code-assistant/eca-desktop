import { app, Menu, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { DOCS_URL, ISSUES_URL } from './constants';
import * as editorActions from './editor-actions';
import { getLogStore } from './log-store';
import { openPreferencesWindow } from './preferences-window';

export function createMenu(mainWindow: BrowserWindow) {
    const isMac = process.platform === 'darwin';

    // Forward a message to the webview (consumed by RootWrapper via
    // `useWebviewListener`). Used for every menu item whose target lives
    // inside the React chat UI.
    const sendWebview = (type: string, data: unknown = {}) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-message', { type, data });
        }
    };

    // Raw IPC to the host renderer (sidebar/welcome), bypassing the webview
    // bridge. Used for chat navigation (sidebar.ts owns the authoritative
    // chat ordering) and for triggering the native "open folder" dialog.
    const sendRenderer = (channel: string, payload?: unknown) => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
        }
    };

    // Hidden menu items register `CmdOrCtrl+1..9` as "jump to chat N"
    // accelerators without cluttering the menu bar. `visible: false` keeps
    // them invisible but functional.
    const jumpToChatItems: Electron.MenuItemConstructorOptions[] = [];
    for (let i = 1; i <= 9; i++) {
        jumpToChatItems.push({
            label: `Go to Chat ${i}`,
            accelerator: `CmdOrCtrl+${i}`,
            visible: false,
            click: () => sendRenderer('chat-navigate', { direction: 'index', index: i - 1 }),
        });
    }

    const template: Electron.MenuItemConstructorOptions[] = [
        // App menu (macOS only)
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                {
                    label: 'Preferences…',
                    accelerator: 'Cmd+,',
                    click: () => openPreferencesWindow(mainWindow),
                },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
            ],
        }] : []),

        // File menu
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Chat',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => sendWebview('chat/createNewChat'),
                },
                {
                    label: 'New Session…',
                    accelerator: 'CmdOrCtrl+Shift+N',
                    click: () => sendRenderer('trigger-create-session'),
                },
                { type: 'separator' },
                {
                    label: 'Rename Chat…',
                    accelerator: 'F2',
                    click: () => sendWebview('chat/renameCurrent'),
                },
                {
                    label: 'Clear Chat',
                    accelerator: 'CmdOrCtrl+Shift+K',
                    click: () => sendWebview('chat/clearCurrent'),
                },
                {
                    label: 'Export Chat…',
                    accelerator: 'CmdOrCtrl+Shift+E',
                    click: () => sendWebview('chat/exportCurrent'),
                },
                { type: 'separator' },
                {
                    label: 'Close Chat',
                    accelerator: 'CmdOrCtrl+W',
                    click: () => sendWebview('chat/closeCurrent'),
                },
                {
                    label: 'Close Window',
                    accelerator: 'CmdOrCtrl+Shift+W',
                    click: () => mainWindow.close(),
                },
                ...(isMac ? [] : [
                    { type: 'separator' as const },
                    {
                        label: 'Preferences…',
                        accelerator: 'Ctrl+,',
                        click: () => openPreferencesWindow(mainWindow),
                    },
                    { type: 'separator' as const },
                    { role: 'quit' as const },
                ]),
            ],
        },

        // Edit menu
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },

        // View menu
        //
        // NOTE: resetZoom/zoomIn/zoomOut roles are intentionally omitted.
        // The webview owns `CmdOrCtrl+(+/-/0)` via RootWrapper's document-
        // level keydown listener (font scale, persisted to localStorage).
        // Leaving the Electron roles in would double-fire on the same keys.
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                {
                    label: 'Toggle Sidebar',
                    accelerator: 'CmdOrCtrl+B',
                    click: () => sendRenderer('sidebar-toggle'),
                },
                { type: 'separator' },
                {
                    label: 'Open Settings Page',
                    accelerator: 'CmdOrCtrl+Shift+,',
                    click: () => sendWebview('navigateTo', { path: '/settings' }),
                },
                {
                    label: 'View Logs',
                    // Re-uses the existing `navigateTo` listener in
                    // RootWrapper; Settings reads `location.state.tab`
                    // to pick the initial tab.
                    click: () => sendWebview('navigateTo', {
                        path: '/settings',
                        state: { tab: 'logs' },
                    }),
                },
                {
                    label: 'Open Global Config…',
                    click: () => editorActions.openGlobalConfig(),
                },
            ],
        },

        // Chat menu
        {
            label: 'Chat',
            submenu: [
                {
                    label: 'Focus Prompt',
                    accelerator: 'CmdOrCtrl+L',
                    click: () => sendWebview('chat/focusPrompt'),
                },
                {
                    label: 'Stop Generation',
                    accelerator: 'CmdOrCtrl+.',
                    click: () => sendWebview('chat/stopCurrent'),
                },
                { type: 'separator' },
                {
                    label: 'Next Chat',
                    accelerator: 'Ctrl+Tab',
                    click: () => sendRenderer('chat-navigate', { direction: 'next' }),
                },
                {
                    label: 'Previous Chat',
                    accelerator: 'Ctrl+Shift+Tab',
                    click: () => sendRenderer('chat-navigate', { direction: 'prev' }),
                },
                ...jumpToChatItems,
            ],
        },

        // Window menu
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                ...(isMac ? [
                    { type: 'separator' as const },
                    { role: 'front' as const },
                ] : []),
            ],
        },

        // Help menu
        {
            label: 'Help',
            submenu: [
                {
                    label: 'ECA Documentation',
                    click: () => {
                        shell.openExternal(DOCS_URL);
                    },
                },
                {
                    label: 'Report Issue',
                    click: () => {
                        shell.openExternal(ISSUES_URL);
                    },
                },
                { type: 'separator' },
                {
                    label: 'Open Logs Folder',
                    // Reveals `eca-server.log` in the OS file manager
                    // so the file can be attached to bug reports.
                    click: () => {
                        const file = getLogStore().logFilePath();
                        if (file) shell.showItemInFolder(file);
                    },
                },
            ],
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
