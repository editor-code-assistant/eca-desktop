import { contextBridge, ipcRenderer } from 'electron';

type MessageCallback = (message: any) => void;

const listeners: MessageCallback[] = [];

// Listen for messages from the main process (server notifications)
ipcRenderer.on('server-message', (_event, message) => {
    listeners.forEach(cb => cb(message));
});

// Expose a minimal API to the renderer via contextBridge
contextBridge.exposeInMainWorld('ecaDesktop', {
    // Send a message from the webview to the main process
    send: (message: any) => {
        ipcRenderer.send('webview-message', message);
    },

    // Register a callback for messages from the main process
    onMessage: (callback: MessageCallback) => {
        listeners.push(callback);
    },

    // Remove a message callback
    removeMessageListener: (callback: MessageCallback) => {
        const index = listeners.indexOf(callback);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    },

    // Platform info for the webview
    platform: process.platform,
});
