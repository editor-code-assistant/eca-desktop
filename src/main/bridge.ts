import { BrowserWindow, ipcMain } from 'electron';
import { EcaServer, EcaServerStatus } from './server';
import * as rpc from './rpc';

// Track MCP server state for the session
const mcpServers: Record<string, any> = {};

export function createBridge(mainWindow: BrowserWindow, server: EcaServer) {

    // ============================================================
    // Helper to send messages to the renderer
    // ============================================================
    function sendToRenderer(type: string, data: any) {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-message', { type, data });
        }
    }

    // ============================================================
    // Server status changes
    // ============================================================
    server.onStatusChanged = (status: EcaServerStatus) => {
        sendToRenderer('server/statusChanged', status);
    };

    // ============================================================
    // Server -> Renderer (JSON-RPC notifications)
    // Register these after server starts and connection is available
    // ============================================================
    function registerServerNotifications() {
        const conn = server.connection;
        if (!conn) return;

        conn.onNotification(rpc.chatContentReceived, (params) => {
            sendToRenderer('chat/contentReceived', params);
        });

        conn.onNotification(rpc.chatCleared, (params) => {
            sendToRenderer('chat/cleared', params);
        });

        conn.onNotification(rpc.chatDeleted, (params) => {
            sendToRenderer('chat/deleted', params.chatId);
        });

        conn.onNotification(rpc.chatOpened, (params) => {
            sendToRenderer('chat/opened', params);
        });

        conn.onNotification(rpc.chatStatusChanged, (params) => {
            sendToRenderer('chat/statusChanged', params);
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

        try {
            switch (message.type) {
                // --- Chat Requests (need response back to renderer) ---
                case 'chat/userPrompt': {
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
                    break;
                }
                case 'chat/queryContext': {
                    const result = await conn.sendRequest(rpc.chatQueryContext, message.data);
                    sendToRenderer('chat/queryContext', result);
                    break;
                }
                case 'chat/queryCommands': {
                    const result = await conn.sendRequest(rpc.chatQueryCommands, message.data);
                    sendToRenderer('chat/queryCommands', result);
                    break;
                }
                case 'chat/queryFiles': {
                    const result = await conn.sendRequest(rpc.chatQueryFiles, message.data);
                    sendToRenderer('chat/queryFiles', result);
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

                default:
                    console.warn('[Bridge] Unhandled message type:', message.type);
            }
        } catch (err) {
            console.error(`[Bridge] Error handling ${message.type}:`, err);
        }
    });

    return { registerServerNotifications };
}
