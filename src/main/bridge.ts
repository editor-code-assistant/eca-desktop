import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { EcaServer, EcaServerStatus } from './server';
import * as rpc from './rpc';

// Track MCP server state for the session
const mcpServers: Record<string, any> = {};

// ============================================================
// Chat list tracking for sidebar
// ============================================================
interface ChatEntry {
    id: string;
    title: string;
    status: string;
    workspaceFolderName: string;
}

export function createBridge(mainWindow: BrowserWindow, server: EcaServer, workspaceFolders: { name: string; uri: string }[] = []) {

    // ============================================================
    // Helper to send messages to the renderer
    // ============================================================
    function sendToRenderer(type: string, data: any) {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-message', { type, data });
        }
    }

    // ============================================================
    // Sidebar: chat list state
    // ============================================================
    const chatEntries = new Map<string, ChatEntry>();
    const chatPayloads = new Map<string, any>();
    const chatContentEvents = new Map<string, any[]>();
    let selectedChatId: string | null = null;
    const workspaceFolderName = workspaceFolders[0]?.name || path.basename(process.cwd());

    function sendChatListUpdate() {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('chat-list-update', {
                entries: Array.from(chatEntries.values()).reverse(),
                selectedId: selectedChatId,
                activeWorkspaceFolderName: workspaceFolderName,
            });
        }
    }

    // ============================================================
    // Server status changes
    // ============================================================
    server.onStatusChanged = (status: EcaServerStatus) => {
        sendToRenderer('server/statusChanged', status);
    };

    // ============================================================
    // Re-hydrate renderer after reload (dev live-reload or manual)
    // ============================================================
    mainWindow.webContents.on('did-finish-load', () => {
        // Re-send current server status so the webview doesn't get stuck
        sendToRenderer('server/statusChanged', server.status);

        // Re-send cached MCP server state
        const servers = Object.values(mcpServers);
        if (servers.length > 0) {
            sendToRenderer('tool/serversUpdated', servers);
        }

        // Re-send workspace folders so the webview has them after reload
        sendToRenderer('server/setWorkspaceFolders', workspaceFolders);

        // Re-hydrate chats: re-open each chat shell, then batch-replay content
        for (const [, payload] of chatPayloads) {
            sendToRenderer('chat/opened', payload);
        }
        for (const [, events] of chatContentEvents) {
            if (events.length > 0) {
                sendToRenderer('chat/batchContentReceived', events);
            }
        }

        // Restore the selected chat if it still exists
        if (selectedChatId && chatPayloads.has(selectedChatId)) {
            sendToRenderer('chat/selectChat', selectedChatId);
        }

        // Re-send sidebar chat list
        sendChatListUpdate();
    });

    // ============================================================
    // Server -> Renderer (JSON-RPC notifications)
    // Register these after server starts and connection is available
    // ============================================================
    function registerServerNotifications() {
        const conn = server.connection;
        if (!conn) return;

        conn.onNotification(rpc.chatContentReceived, (params) => {
            // Cache for replay after webview reload
            const events = chatContentEvents.get(params.chatId) || [];
            events.push(params);
            chatContentEvents.set(params.chatId, events);

            sendToRenderer('chat/contentReceived', params);
        });

        conn.onNotification(rpc.chatCleared, (params) => {
            if (params.messages) {
                chatContentEvents.delete(params.chatId);
            }
            sendToRenderer('chat/cleared', params);
        });

        conn.onNotification(rpc.chatDeleted, (params) => {
            sendToRenderer('chat/deleted', params.chatId);
            // Remove from sidebar and content cache
            chatEntries.delete(params.chatId);
            chatPayloads.delete(params.chatId);
            chatContentEvents.delete(params.chatId);
            if (selectedChatId === params.chatId) {
                selectedChatId = null;
            }
            sendChatListUpdate();
        });

        conn.onNotification(rpc.chatOpened, (params) => {
            sendToRenderer('chat/opened', params);
            // Track in sidebar
            const chatId = params.chatId;
            if (chatId) {
                chatEntries.set(chatId, {
                    id: chatId,
                    title: params.title || chatEntries.get(chatId)?.title || 'New Chat',
                    status: params.status || 'idle',
                    workspaceFolderName,
                });
                chatPayloads.set(chatId, params);
                selectedChatId = chatId;
                sendChatListUpdate();
            }
        });

        conn.onNotification(rpc.chatStatusChanged, (params) => {
            sendToRenderer('chat/statusChanged', params);
            // Update sidebar status
            const entry = chatEntries.get(params.chatId);
            if (entry) {
                entry.status = params.status;
                sendChatListUpdate();
            }
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

    // ============================================================
    // Renderer -> Server (IPC -> JSON-RPC)
    // ============================================================
    ipcMain.on('webview-message', async (_event, message) => {
        const conn = server.connection;
        if (!conn) {
            console.error('[Bridge] No server connection, dropping message:', message.type);
            return;
        }

        if (server.status !== EcaServerStatus.Running) {
            console.warn('[Bridge] Server not ready, dropping message:', message.type);
            return;
        }

        try {
            switch (message.type) {
                case 'webview/ready': {
                    sendToRenderer('server/statusChanged', server.status);
                    sendToRenderer('server/setWorkspaceFolders', workspaceFolders);
                    break;
                }
                // --- Chat Requests (need response back to renderer) ---
                case 'chat/userPrompt': {
                    const isNewChat = !message.data.chatId;
                    const promptText = message.data.prompt || '';
                    const result = await conn.sendRequest(rpc.chatPrompt, {
                        chatId: message.data.chatId,
                        message: message.data.prompt,
                        model: message.data.model,
                        agent: message.data.agent,
                        variant: message.data.variant,
                        trust: message.data.trust,
                        requestId: message.data.requestId?.toString(),
                        contexts: message.data.contexts,
                    });
                    sendToRenderer('chat/newChat', { id: result.chatId });
                    // Track in sidebar
                    if (isNewChat && result.chatId) {
                        const title = promptText.length > 50
                            ? promptText.substring(0, 50) + '…'
                            : (promptText || 'New Chat');
                        chatEntries.set(result.chatId, {
                            id: result.chatId,
                            title,
                            status: 'generating',
                            workspaceFolderName,
                        });
                    }
                    if (result.chatId) {
                        selectedChatId = result.chatId;
                    }
                    sendChatListUpdate();
                    break;
                }
                case 'chat/queryContext': {
                    try {
                        const result = await conn.sendRequest(rpc.chatQueryContext, message.data);
                        sendToRenderer('chat/queryContext', result);
                    } catch (err) {
                        console.warn('[Bridge] chat/queryContext failed, returning empty:', err);
                        sendToRenderer('chat/queryContext', { contexts: [], requestId: message.data?.requestId });
                    }
                    break;
                }
                case 'chat/queryCommands': {
                    try {
                        const result = await conn.sendRequest(rpc.chatQueryCommands, message.data);
                        sendToRenderer('chat/queryCommands', result);
                    } catch (err) {
                        console.warn('[Bridge] chat/queryCommands failed, returning empty:', err);
                        sendToRenderer('chat/queryCommands', { commands: [], requestId: message.data?.requestId });
                    }
                    break;
                }
                case 'chat/queryFiles': {
                    try {
                        const result = await conn.sendRequest(rpc.chatQueryFiles, message.data);
                        sendToRenderer('chat/queryFiles', result);
                    } catch (err) {
                        console.warn('[Bridge] chat/queryFiles failed, returning empty:', err);
                        sendToRenderer('chat/queryFiles', { files: [], requestId: message.data?.requestId });
                    }
                    break;
                }
                case 'chat/delete': {
                    await conn.sendRequest(rpc.chatDelete, { chatId: message.data.chatId });
                    break;
                }
                case 'chat/rollback': {
                    await conn.sendRequest(rpc.chatRollback, message.data);
                    break;
                }
                case 'chat/addFlag': {
                    await conn.sendRequest(rpc.chatAddFlag, message.data);
                    break;
                }
                case 'chat/removeFlag': {
                    await conn.sendRequest(rpc.chatRemoveFlag, message.data);
                    break;
                }
                case 'chat/fork': {
                    await conn.sendRequest(rpc.chatFork, message.data);
                    break;
                }
                case 'chat/update': {
                    await conn.sendRequest(rpc.chatUpdate, message.data);
                    break;
                }

                // --- Chat Notifications (fire-and-forget) ---
                case 'chat/toolCallApprove': {
                    conn.sendNotification(rpc.chatToolCallApprove, message.data);
                    break;
                }
                case 'chat/toolCallReject': {
                    conn.sendNotification(rpc.chatToolCallReject, message.data);
                    break;
                }
                case 'chat/promptStop': {
                    conn.sendNotification(rpc.chatPromptStop, { chatId: message.data.chatId });
                    break;
                }
                case 'chat/promptSteer': {
                    conn.sendNotification(rpc.chatPromptSteer, message.data);
                    break;
                }
                case 'chat/selectedModelChanged': {
                    conn.sendNotification(rpc.chatSelectedModelChanged, message.data);
                    break;
                }
                case 'chat/selectedAgentChanged': {
                    conn.sendNotification(rpc.chatSelectedAgentChanged, message.data);
                    break;
                }

                // --- MCP ---
                case 'mcp/startServer': {
                    conn.sendNotification(rpc.mcpStartServer, { name: message.data.name });
                    break;
                }
                case 'mcp/stopServer': {
                    conn.sendNotification(rpc.mcpStopServer, { name: message.data.name });
                    break;
                }
                case 'mcp/connectServer': {
                    conn.sendNotification(rpc.mcpConnectServer, { name: message.data.name });
                    break;
                }
                case 'mcp/logoutServer': {
                    conn.sendNotification(rpc.mcpLogoutServer, { name: message.data.name });
                    break;
                }
                case 'mcp/disableServer': {
                    conn.sendNotification(rpc.mcpDisableServer, { name: message.data.name });
                    break;
                }
                case 'mcp/enableServer': {
                    conn.sendNotification(rpc.mcpEnableServer, { name: message.data.name });
                    break;
                }
                case 'mcp/updateServer': {
                    const result = await conn.sendRequest(rpc.mcpUpdateServer, {
                        name: message.data.name,
                        ...(message.data.command && { command: message.data.command }),
                        ...(message.data.args && { args: message.data.args }),
                        ...(message.data.url && { url: message.data.url }),
                    });
                    sendToRenderer('mcp/updateServer', { requestId: message.data.requestId, ...result });
                    break;
                }

                // --- Providers ---
                case 'providers/list': {
                    const result = await conn.sendRequest(rpc.providersList, message.data);
                    sendToRenderer('providers/list', { ...result, requestId: message.data.requestId });
                    break;
                }
                case 'providers/login': {
                    const result = await conn.sendRequest(rpc.providersLogin, message.data);
                    sendToRenderer('providers/login', { ...result, requestId: message.data.requestId });
                    break;
                }
                case 'providers/loginInput': {
                    const result = await conn.sendRequest(rpc.providersLoginInput, message.data);
                    sendToRenderer('providers/loginInput', { ...result, requestId: message.data.requestId });
                    break;
                }
                case 'providers/logout': {
                    const result = await conn.sendRequest(rpc.providersLogout, message.data);
                    sendToRenderer('providers/logout', { ...result, requestId: message.data.requestId });
                    break;
                }

                // --- Background Jobs ---
                case 'jobs/list': {
                    const result = await conn.sendRequest(rpc.jobsList, {});
                    sendToRenderer('jobs/list', { ...result, requestId: message.data.requestId });
                    break;
                }
                case 'jobs/readOutput': {
                    const result = await conn.sendRequest(rpc.jobsReadOutput, { jobId: message.data.jobId });
                    sendToRenderer('jobs/readOutput', { ...result, requestId: message.data.requestId });
                    break;
                }
                case 'jobs/kill': {
                    const result = await conn.sendRequest(rpc.jobsKill, { jobId: message.data.jobId });
                    sendToRenderer('jobs/kill', { ...result, requestId: message.data.requestId });
                    break;
                }

                // --- Editor actions (handled by desktop app directly) ---
                case 'editor/openFile': {
                    const { shell } = require('electron');
                    shell.openPath(message.data.path);
                    break;
                }
                case 'editor/openUrl': {
                    const { shell } = require('electron');
                    shell.openExternal(message.data.url);
                    break;
                }
                case 'editor/saveFile': {
                    const { dialog } = require('electron');
                    const fs = require('fs');
                    const os = require('os');
                    const path = require('path');
                    const defaultName = message.data.defaultName || 'chat-export.md';
                    const result = await dialog.showSaveDialog(mainWindow, {
                        defaultPath: path.join(os.homedir(), defaultName),
                        filters: [
                            { name: 'Markdown', extensions: ['md'] },
                            { name: 'All Files', extensions: ['*'] },
                        ],
                    });
                    if (!result.canceled && result.filePath) {
                        fs.writeFileSync(result.filePath, message.data.content, 'utf-8');
                    }
                    break;
                }
                case 'editor/saveClipboardImage': {
                    const fs = require('fs');
                    const os = require('os');
                    const path = require('path');
                    const { base64Data, mimeType, requestId } = message.data;
                    const extMap: Record<string, string> = {
                        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
                        'image/webp': 'webp', 'image/svg+xml': 'svg',
                    };
                    const ext = extMap[mimeType] || 'png';
                    const tmpPath = path.join(os.tmpdir(), `eca-screenshot-${Date.now()}.${ext}`);
                    try {
                        fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
                        sendToRenderer('editor/saveClipboardImage', { requestId, path: tmpPath });
                    } catch (err) {
                        console.error('[Bridge] Failed to save clipboard image:', err);
                    }
                    break;
                }

                // --- Sidebar toggle (from webview ChatHeader) ---
                case 'editor/toggleSidebar': {
                    if (!mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('sidebar-toggle');
                    }
                    break;
                }

                default:
                    console.warn('[Bridge] Unhandled message type:', message.type);
            }
        } catch (err) {
            console.error(`[Bridge] Error handling ${message.type}:`, err);
        }
    });

    // ============================================================
    // Sidebar -> Server (IPC from sidebar UI)
    // ============================================================
    ipcMain.on('chat-select', (_event, chatId: string) => {
        selectedChatId = chatId;
        sendToRenderer('chat/selectChat', chatId);
        sendChatListUpdate();
    });

    ipcMain.on('chat-new', () => {
        selectedChatId = null;
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
