// ============================================================
// Bridge — thin orchestrator wiring IPC, router, and chat state
// ============================================================

import { BrowserWindow, ipcMain } from 'electron';
import { EcaServer, EcaServerStatus } from './server';
import { ChatState } from './chat-state';
import { dispatch, RouteContext } from './router';
import { IpcMessage, ToolServerUpdatedParams, WorkspaceFolder } from './protocol';
import * as rpc from './rpc';

// Track MCP server state for the session
const mcpServers: Record<string, ToolServerUpdatedParams> = {};

export function createBridge(
    mainWindow: BrowserWindow,
    server: EcaServer,
    workspaceFolders: WorkspaceFolder[] = [],
) {
    const chatState = new ChatState(workspaceFolders);

    // ── Helper: send to renderer ──

    function sendToRenderer(type: string, data: unknown): void {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-message', { type, data });
        }
    }

    function sendChatListUpdate(): void {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('chat-list-update', chatState.getChatListUpdate());
        }
    }

    // ── Server status ──

    server.onStatusChanged = (status: EcaServerStatus) => {
        sendToRenderer('server/statusChanged', status);
    };

    // ── Rehydration on reload ──

    mainWindow.webContents.on('did-finish-load', () => {
        sendToRenderer('server/statusChanged', server.status);

        const servers = Object.values(mcpServers);
        if (servers.length > 0) {
            sendToRenderer('tool/serversUpdated', servers);
        }

        chatState.rehydrate(sendToRenderer, workspaceFolders);
        sendChatListUpdate();
    });

    // ── Server → Renderer (JSON-RPC notifications) ──

    function registerServerNotifications(): void {
        const conn = server.connection;
        if (!conn) return;

        conn.onNotification(rpc.chatContentReceived, (params) => {
            chatState.pushContentEvent(params.chatId, params);
            sendToRenderer('chat/contentReceived', params);
        });

        conn.onNotification(rpc.chatCleared, (params) => {
            if (params.messages) {
                chatState.clearContentEvents(params.chatId);
            }
            sendToRenderer('chat/cleared', params);
        });

        conn.onNotification(rpc.chatDeleted, (params) => {
            sendToRenderer('chat/deleted', params.chatId);
            chatState.removeEntry(params.chatId);
            sendChatListUpdate();
        });

        conn.onNotification(rpc.chatOpened, (params) => {
            sendToRenderer('chat/opened', params);
            if (params.chatId) {
                chatState.addOrUpdateEntry(params.chatId, {
                    title: params.title ?? 'New Chat',
                    status: params.status ?? 'idle',
                });
                chatState.cachePayload(params.chatId, params);
                chatState.selectedChatId = params.chatId;
                sendChatListUpdate();
            }
        });

        conn.onNotification(rpc.chatStatusChanged, (params) => {
            sendToRenderer('chat/statusChanged', params);
            chatState.updateStatus(params.chatId, params.status);
            sendChatListUpdate();
        });

        conn.onNotification(rpc.toolServerUpdated, (params) => {
            mcpServers[params.name] = params;
            sendToRenderer('tool/serversUpdated', Object.values(mcpServers));
        });

        conn.onNotification(rpc.configUpdated, (params) => {
            sendToRenderer('config/updated', params);
        });

        conn.onNotification(rpc.providersUpdated, (params) => {
            sendToRenderer('providers/updated', params);
        });

        conn.onNotification(rpc.jobsUpdated, (params) => {
            sendToRenderer('jobs/updated', params);
        });
    }

    // ── Renderer → Server (IPC dispatch) ──

    ipcMain.on('webview-message', async (_event, message: IpcMessage) => {
        const conn = server.connection;
        if (!conn) {
            console.error('[Bridge] No server connection, dropping message:', message.type);
            return;
        }

        if (server.status !== EcaServerStatus.Running && message.type !== 'webview/ready') {
            console.warn('[Bridge] Server not ready, dropping message:', message.type);
            return;
        }

        const ctx: RouteContext = {
            conn,
            sendToRenderer,
            mainWindow,
            chatState,
            workspaceFolders,
        };

        try {
            // webview/ready is special — send status + workspace immediately
            if (message.type === 'webview/ready') {
                sendToRenderer('server/statusChanged', server.status);
                sendToRenderer('server/setWorkspaceFolders', workspaceFolders);
                return;
            }

            await dispatch(ctx, message);

            // After any chat mutation, push updated sidebar list
            if (message.type.startsWith('chat/')) {
                sendChatListUpdate();
            }
        } catch (err) {
            console.error(`[Bridge] Error handling ${message.type}:`, err);
        }
    });

    // ── Sidebar IPC ──

    ipcMain.on('chat-select', (_event, chatId: string) => {
        chatState.selectedChatId = chatId;
        sendToRenderer('chat/selectChat', chatId);
        sendChatListUpdate();
    });

    ipcMain.on('chat-new', () => {
        chatState.selectedChatId = null;
        sendToRenderer('chat/createNewChat', {});
        sendChatListUpdate();
    });

    ipcMain.on('chat-delete', async (_event, chatId: string) => {
        const conn = server.connection;
        if (conn) {
            try {
                await conn.sendRequest(rpc.chatDelete, { chatId });
            } catch (err) {
                console.error('[Bridge] Error deleting chat:', err);
            }
        }
    });

    return { registerServerNotifications };
}
