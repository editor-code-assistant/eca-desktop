import { contextBridge, ipcRenderer } from 'electron';
import type { Preferences } from '../main/preferences-store';

// IPC payloads are intentionally typed as `unknown` at this boundary:
// each renderer that consumes a callback re-declares `window.ecaDesktop`
// with the precise message shape it expects (see e.g. sidebar.ts /
// preferences.ts). Keeping preload loose avoids forcing every event
// into a single union type.
type MessageCallback = (message: unknown) => void;
type VoidCallback = () => void;

// Server message listeners
const listeners: MessageCallback[] = [];
ipcRenderer.on('server-message', (_event, message) => {
    listeners.forEach(cb => cb(message));
});

// Sidebar: chat list update listeners
const chatListListeners: MessageCallback[] = [];
ipcRenderer.on('chat-list-update', (_event, data) => {
    chatListListeners.forEach(cb => cb(data));
});

// Sidebar: toggle listeners
const sidebarToggleListeners: VoidCallback[] = [];
ipcRenderer.on('sidebar-toggle', () => {
    sidebarToggleListeners.forEach(cb => cb());
});

// Chat navigation (Next/Prev/Jump-to-N) — computed by the sidebar based on
// its authoritative chat list, then dispatched back via `selectChat`.
type ChatNavigatePayload = { direction: 'next' | 'prev' | 'index'; index?: number };
const chatNavigateListeners: ((data: ChatNavigatePayload) => void)[] = [];
ipcRenderer.on('chat-navigate', (_event, data: ChatNavigatePayload) => {
    chatNavigateListeners.forEach(cb => cb(data));
});

// Trigger the native "Open Workspace Folder" dialog from the menu. Routed
// through the renderer so it reuses the existing `createSession` IPC path.
const triggerCreateSessionListeners: VoidCallback[] = [];
ipcRenderer.on('trigger-create-session', () => {
    triggerCreateSessionListeners.forEach(cb => cb());
});

// Session: list update listeners
const sessionListListeners: MessageCallback[] = [];
ipcRenderer.on('session-list-update', (_event, data) => {
    sessionListListeners.forEach(cb => cb(data));
});

// Session: welcome data listeners
const welcomeDataListeners: MessageCallback[] = [];
ipcRenderer.on('welcome-data', (_event, data) => {
    welcomeDataListeners.forEach(cb => cb(data));
});

// Preferences: update listeners
const preferencesUpdatedListeners: MessageCallback[] = [];
ipcRenderer.on('preferences-updated', (_event, data) => {
    preferencesUpdatedListeners.forEach(cb => cb(data));
});

// Sidebar: collapse state listeners
const sidebarCollapseListeners: MessageCallback[] = [];
ipcRenderer.on('sidebar-collapse-changed', (_event, data) => {
    sidebarCollapseListeners.forEach(cb => cb(data));
});

// Expose API to the renderer via contextBridge
contextBridge.exposeInMainWorld('ecaDesktop', {
    // ── Server message transport ──
    send: (message: unknown) => {
        // Defense-in-depth: the renderer is expected to pass a tagged
        // envelope `{ type: string, ... }` through this channel. Reject
        // anything without a string `type` so a compromised/buggy script
        // cannot forward arbitrary blobs to the main process. The main
        // router does its own shape validation; this is a belt-and-braces
        // guard at the IPC boundary.
        const type = (message as { type?: unknown } | null | undefined)?.type;
        if (typeof type !== 'string') {
            throw new Error('ecaDesktop.send: message.type must be a string');
        }
        ipcRenderer.send('webview-message', message);
    },
    onMessage: (callback: MessageCallback) => {
        listeners.push(callback);
    },
    removeMessageListener: (callback: MessageCallback) => {
        const index = listeners.indexOf(callback);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    },
    platform: process.platform,

    // ── Sidebar: chat list ──
    onChatListUpdate: (callback: MessageCallback) => {
        chatListListeners.push(callback);
    },
    onSidebarToggle: (callback: VoidCallback) => {
        sidebarToggleListeners.push(callback);
    },
    removeChatListListener: (callback: MessageCallback) => {
        const index = chatListListeners.indexOf(callback);
        if (index !== -1) {
            chatListListeners.splice(index, 1);
        }
    },
    removeSidebarToggleListener: (callback: VoidCallback) => {
        const index = sidebarToggleListeners.indexOf(callback);
        if (index !== -1) {
            sidebarToggleListeners.splice(index, 1);
        }
    },
    // ── Chat navigation (Next/Prev/Jump-to-N) from the menu ──
    onChatNavigate: (callback: (data: ChatNavigatePayload) => void) => {
        chatNavigateListeners.push(callback);
    },
    removeChatNavigateListener: (callback: (data: ChatNavigatePayload) => void) => {
        const index = chatNavigateListeners.indexOf(callback);
        if (index !== -1) chatNavigateListeners.splice(index, 1);
    },
    // ── "New Session" menu item → open-folder dialog ──
    onTriggerCreateSession: (callback: VoidCallback) => {
        triggerCreateSessionListeners.push(callback);
    },
    removeTriggerCreateSessionListener: (callback: VoidCallback) => {
        const index = triggerCreateSessionListeners.indexOf(callback);
        if (index !== -1) triggerCreateSessionListeners.splice(index, 1);
    },
    selectChat: (chatId: string) => {
        ipcRenderer.send('chat-select', chatId);
    },
    newChat: (sessionId?: string) => {
        ipcRenderer.send('chat-new', sessionId ? { sessionId } : undefined);
    },
    deleteChat: (chatId: string) => {
        ipcRenderer.send('chat-delete', chatId);
    },

    // ── Session management ──
    createSession: (uri?: string) => {
        ipcRenderer.send('session-create', { uri });
    },
    removeSession: (sessionId: string) => {
        ipcRenderer.send('session-remove', { sessionId });
    },
    onSessionListUpdate: (callback: MessageCallback) => {
        sessionListListeners.push(callback);
    },
    removeSessionListListener: (callback: MessageCallback) => {
        const index = sessionListListeners.indexOf(callback);
        if (index !== -1) sessionListListeners.splice(index, 1);
    },
    onWelcomeData: (callback: MessageCallback) => {
        welcomeDataListeners.push(callback);
    },
    removeWelcomeDataListener: (callback: MessageCallback) => {
        const index = welcomeDataListeners.indexOf(callback);
        if (index !== -1) welcomeDataListeners.splice(index, 1);
    },

    // ── Sidebar collapse ──
    toggleSidebar: () => {
        ipcRenderer.send('sidebar-collapse-toggle');
    },
    onSidebarCollapseChanged: (callback: MessageCallback) => {
        sidebarCollapseListeners.push(callback);
    },
    removeSidebarCollapseListener: (callback: MessageCallback) => {
        const index = sidebarCollapseListeners.indexOf(callback);
        if (index !== -1) sidebarCollapseListeners.splice(index, 1);
    },

    // ── Preferences (request/response via invoke/handle) ──
    getPreferences: () => ipcRenderer.invoke('preferences:get'),
    setPreferences: (patch: Partial<Preferences>) => ipcRenderer.invoke('preferences:set', patch),
    pickServerBinary: () => ipcRenderer.invoke('preferences:pick-binary'),
    onPreferencesUpdated: (callback: MessageCallback) => {
        preferencesUpdatedListeners.push(callback);
    },
    removePreferencesUpdatedListener: (callback: MessageCallback) => {
        const index = preferencesUpdatedListeners.indexOf(callback);
        if (index !== -1) preferencesUpdatedListeners.splice(index, 1);
    },
});
