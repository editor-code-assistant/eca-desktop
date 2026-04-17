// ============================================================
// Bridge — thin orchestrator wiring IPC, router, and chat state
// ============================================================

import { BrowserWindow, ipcMain } from 'electron';
import { EcaServerStatus } from './server';
import { ChatState, PENDING_CHAT_ID } from './chat-state';
import { dispatch, RouteContext } from './router';
import { IpcMessage, ToolServerUpdatedParams, WorkspaceFolder, ChatEntry, AskQuestionResult } from './protocol';
import * as jsonrpc from 'vscode-jsonrpc/node';
import * as rpc from './rpc';
import { SessionManager, Session } from './session-manager';
import { SessionStore } from './session-store';

// Track MCP server, config and providers state per session
const mcpServers = new Map<string, Record<string, ToolServerUpdatedParams>>();
const configCache = new Map<string, unknown>();
const providersCache = new Map<string, unknown>();

export function createBridge(
    mainWindow: BrowserWindow,
    sessionManager: SessionManager,
    sessionStore: SessionStore,
) {
    // ── Pending askQuestion requests ──

    let nextAskQuestionId = 1;
    const pendingQuestions = new Map<string, {
        resolve: (result: AskQuestionResult) => void;
    }>();

    // ── Helpers: resolve active session ──

    function getActiveSession(): Session | undefined {
        return sessionManager.getActiveSession();
    }

    function getActiveChatState(): ChatState | undefined {
        return getActiveSession()?.chatState;
    }

    function getActiveConnection(): jsonrpc.MessageConnection | undefined {
        const session = getActiveSession();
        return session?.ecaServer.connection ?? undefined;
    }

    // ── Helper: send to renderer ──

    function sendToRenderer(type: string, data: unknown): void {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-message', { type, data });
        }
    }

    function sendChatListUpdate(): void {
        if (!mainWindow.isDestroyed()) {
            const allEntries: ChatEntry[] = [];
            for (const session of sessionManager.getAllSessions()) {
                const update = session.chatState.getChatListUpdate();
                allEntries.push(...update.entries);
            }
            const activeChatState = getActiveChatState();
            mainWindow.webContents.send('chat-list-update', {
                entries: allEntries,
                selectedId: activeChatState?.selectedChatId ?? null,
                activeWorkspaceFolderName: getActiveSession()?.workspaceFolder.name ?? null,
            });
        }
    }

    function sendSessionListUpdate(): void {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('session-list-update', sessionManager.getSessionInfoList());
        }
    }

    // ── Rehydration on reload ──

    mainWindow.webContents.on('did-finish-load', () => {
        const activeSession = getActiveSession();
        if (activeSession) {
            sendToRenderer('server/statusChanged', activeSession.ecaServer.status);

            const sessionMcpData = mcpServers.get(activeSession.id);
            if (sessionMcpData) {
                sendToRenderer('tool/serversUpdated', Object.values(sessionMcpData));
            }

            // Replay config and providers so the webview knows about models, etc.
            const cachedConfig = configCache.get(activeSession.id);
            if (cachedConfig) {
                sendToRenderer('config/updated', cachedConfig);
            }

            const cachedProviders = providersCache.get(activeSession.id);
            if (cachedProviders) {
                sendToRenderer('providers/updated', cachedProviders);
            }
        }

        // Rehydrate all sessions
        for (const session of sessionManager.getAllSessions()) {
            session.chatState.rehydrate(sendToRenderer, [session.workspaceFolder]);
        }

        sendChatListUpdate();
        sendSessionListUpdate();
    });

    // ── Server → Renderer (JSON-RPC notifications) ──

    function registerServerNotifications(session: Session): void {
        const conn = session.ecaServer.connection;
        if (!conn) return;

        const sessionMcpServers: Record<string, ToolServerUpdatedParams> = {};
        mcpServers.set(session.id, sessionMcpServers);

        session.ecaServer.onStatusChanged = (status: EcaServerStatus) => {
            // Only send status if this is the active session
            if (session.id === sessionManager.activeSessionId) {
                sendToRenderer('server/statusChanged', status);
            }
            sendSessionListUpdate();
        };

        conn.onNotification(rpc.chatContentReceived, (params) => {
            session.chatState.pushContentEvent(params.chatId, params);

            // Update sidebar title when metadata arrives
            const content = (params as Record<string, unknown>).content as
                | { type?: string; title?: string }
                | undefined;
            if (content?.type === 'metadata' && content.title) {
                session.chatState.addOrUpdateEntry(params.chatId, {
                    title: content.title,
                });
                sendChatListUpdate();
            }

            sendToRenderer('chat/contentReceived', params);
        });

        conn.onNotification(rpc.chatCleared, (params) => {
            if (params.messages) {
                session.chatState.clearContentEvents(params.chatId);
            }
            sendToRenderer('chat/cleared', params);
        });

        conn.onNotification(rpc.chatDeleted, (params) => {
            sendToRenderer('chat/deleted', params.chatId);
            session.chatState.removeEntry(params.chatId);
            sendChatListUpdate();
        });

        conn.onNotification(rpc.chatOpened, (params) => {
            sendToRenderer('chat/opened', params);
            if (params.chatId) {
                // Track subagent chats so they never appear in the sidebar
                if (params.parentChatId) {
                    session.chatState.markAsSubagent(params.chatId);
                }

                session.chatState.cachePayload(params.chatId, params);

                // Only add sidebar entry and change selection for non-subagent chats
                if (!session.chatState.isSubagent(params.chatId)) {
                    session.chatState.addOrUpdateEntry(params.chatId, {
                        title: params.title ?? 'New Chat',
                        status: params.status ?? 'idle',
                    });
                    session.chatState.selectedChatId = params.chatId;
                    sessionManager.activeSessionId = session.id;
                    sendChatListUpdate();
                }
            }
        });

        conn.onNotification(rpc.chatStatusChanged, (params) => {
            sendToRenderer('chat/statusChanged', params);
            session.chatState.updateStatus(params.chatId, params.status);
            sendChatListUpdate();
        });

        conn.onNotification(rpc.toolServerUpdated, (params) => {
            sessionMcpServers[params.name] = params;
            // Only send MCP updates for active session
            if (session.id === sessionManager.activeSessionId) {
                sendToRenderer('tool/serversUpdated', Object.values(sessionMcpServers));
            }
        });

        conn.onNotification(rpc.configUpdated, (params) => {
            configCache.set(session.id, params);
            if (session.id === sessionManager.activeSessionId) {
                sendToRenderer('config/updated', params);
            }
        });

        conn.onNotification(rpc.providersUpdated, (params) => {
            providersCache.set(session.id, params);
            if (session.id === sessionManager.activeSessionId) {
                sendToRenderer('providers/updated', params);
            }
        });

        conn.onNotification(rpc.jobsUpdated, (params) => {
            sendToRenderer('jobs/updated', params);
        });

        // ── chat/askQuestion (server → client request) ──

        conn.onRequest(rpc.chatAskQuestion, async (params) => {
            const requestId = `ask-${nextAskQuestionId++}`;
            return new Promise<AskQuestionResult>((resolve) => {
                pendingQuestions.set(requestId, { resolve });
                sendToRenderer('chat/askQuestion', { ...params, requestId });
            });
        });
    }

    // ── Renderer → Server (IPC dispatch) ──

    ipcMain.on('webview-message', async (_event, message: IpcMessage) => {
        const session = getActiveSession();
        const conn = session?.ecaServer.connection ?? null;

        if (!conn) {
            console.error('[Bridge] No active server connection, dropping message:', message.type);
            return;
        }

        if (session!.ecaServer.status !== EcaServerStatus.Running && message.type !== 'webview/ready') {
            console.warn('[Bridge] Server not ready, dropping message:', message.type);
            return;
        }

        const ctx: RouteContext = {
            conn,
            sendToRenderer,
            mainWindow,
            chatState: session!.chatState,
            workspaceFolders: [session!.workspaceFolder],
        };

        try {
            if (message.type === 'webview/ready') {
                sendToRenderer('server/statusChanged', session!.ecaServer.status);
                sendToRenderer('server/setWorkspaceFolders', [session!.workspaceFolder]);
                return;
            }

            // Handle chat/answerQuestion locally — resolve the pending promise
            if (message.type === 'chat/answerQuestion') {
                const { requestId, answer, cancelled } = message.data as {
                    requestId: string;
                    answer: string | null;
                    cancelled: boolean;
                };
                const pending = pendingQuestions.get(requestId);
                if (pending) {
                    pendingQuestions.delete(requestId);
                    pending.resolve({ answer: answer ?? null, cancelled: !!cancelled });
                } else {
                    console.warn('[Bridge] No pending question for requestId:', requestId);
                }
                return;
            }

            await dispatch(ctx, message);

            if (message.type.startsWith('chat/')) {
                sendChatListUpdate();
            }
        } catch (err) {
            console.error(`[Bridge] Error handling ${message.type}:`, err);
        }
    });

    // ── Helpers: send full session context to renderer ──

    function sendSessionContext(session: Session): void {
        sendToRenderer('server/statusChanged', session.ecaServer.status);
        sendToRenderer('server/setWorkspaceFolders', [session.workspaceFolder]);

        const sessionMcpData = mcpServers.get(session.id);
        if (sessionMcpData) {
            sendToRenderer('tool/serversUpdated', Object.values(sessionMcpData));
        }

        const cachedConfig = configCache.get(session.id);
        if (cachedConfig) {
            sendToRenderer('config/updated', cachedConfig);
        }

        const cachedProviders = providersCache.get(session.id);
        if (cachedProviders) {
            sendToRenderer('providers/updated', cachedProviders);
        }
    }

    // ── Sidebar IPC ──

    ipcMain.on('chat-select', (_event, chatId: string) => {
        // Clicking the pending "New Chat" placeholder — keep showing the empty chat
        if (chatId === PENDING_CHAT_ID) {
            const session = sessionManager.getSessionForChat(chatId);
            if (session) {
                sessionManager.activeSessionId = session.id;
                sendSessionContext(session);
            }
            sendToRenderer('chat/createNewChat', {});
            sendChatListUpdate();
            return;
        }

        // Selecting a real chat — remove any pending placeholders
        for (const s of sessionManager.getAllSessions()) {
            s.chatState.removePendingChat();
        }

        const session = sessionManager.getSessionForChat(chatId);
        if (session) {
            sessionManager.activeSessionId = session.id;
            session.chatState.selectedChatId = chatId;
            sendSessionContext(session);

            // Cold chat — loaded from chat/list but never opened in this
            // client run. Ask the server to replay chat/cleared + chat/opened
            // + chat/contentReceived so the existing notification handlers
            // populate the webview.
            if (!session.chatState.hasBeenOpened(chatId)) {
                const conn = session.ecaServer.connection;
                if (conn) {
                    conn.sendRequest(rpc.chatOpen, { chatId })
                        .then((result) => {
                            if (!result?.found) {
                                console.warn('[Bridge] chat/open reported chat not found:', chatId);
                            }
                        })
                        .catch((err) => {
                            console.error('[Bridge] chat/open failed:', err);
                        });
                }
            }
        }
        sendToRenderer('chat/selectChat', chatId);
        sendChatListUpdate();
    });

    ipcMain.on('chat-new', (_event, data?: { sessionId?: string }) => {
        // Clean up any pending "New Chat" placeholders from all sessions
        for (const s of sessionManager.getAllSessions()) {
            s.chatState.removePendingChat();
        }

        const targetSessionId = data?.sessionId ?? sessionManager.activeSessionId;
        if (targetSessionId) {
            const session = sessionManager.getSession(targetSessionId);
            if (session) {
                sessionManager.activeSessionId = session.id;
                session.chatState.addPendingNewChat();
                sendSessionContext(session);
            }
        }
        sendToRenderer('chat/createNewChat', {});
        sendChatListUpdate();
        sendSessionListUpdate();
    });

    ipcMain.on('chat-delete', async (_event, chatId: string) => {
        const session = sessionManager.getSessionForChat(chatId);
        if (session) {
            const conn = session.ecaServer.connection;
            if (conn) {
                try {
                    await conn.sendRequest(rpc.chatDelete, { chatId });
                } catch (err) {
                    console.error('[Bridge] Error deleting chat:', err);
                }
            }
        }
    });

    /**
     * After a session's ECA server has initialized (i.e. `start()` resolved and
     * status is Running), ask the server for the set of persisted chats in the
     * workspace DB and populate the sidebar. Failures are logged and swallowed
     * so an older server binary without `chat/list` support (or a transient
     * RPC error) doesn't break session creation — the sidebar simply stays
     * empty as it did before, and the user can still start a new chat.
     */
    async function loadSessionChats(session: Session): Promise<void> {
        const conn = session.ecaServer.connection;
        if (!conn) return;

        try {
            const { chats } = await conn.sendRequest(rpc.chatList, {});
            if (!chats?.length) return;
            session.chatState.addServerKnownEntries(chats);
            sendChatListUpdate();
        } catch (err) {
            console.warn('[Bridge] chat/list failed (sidebar not auto-populated):', err);
        }
    }

    return {
        registerServerNotifications,
        sendSessionListUpdate,
        sendChatListUpdate,
        loadSessionChats,
    };
}
