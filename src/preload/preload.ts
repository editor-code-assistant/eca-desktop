import { contextBridge, ipcRenderer } from 'electron';

type MessageCallback = (message: any) => void;
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

// Expose API to the renderer via contextBridge
contextBridge.exposeInMainWorld('ecaDesktop', {
    // ── Server message transport ──
    send: (message: any) => {
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
    selectChat: (chatId: string) => {
        ipcRenderer.send('chat-select', chatId);
    },
    newChat: () => {
        ipcRenderer.send('chat-new');
    },
    deleteChat: (chatId: string) => {
        ipcRenderer.send('chat-delete', chatId);
    },
});
