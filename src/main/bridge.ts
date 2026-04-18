// ============================================================
// Bridge — thin orchestrator wiring IPC, router, and chat state
// ============================================================

import type { BrowserWindow} from 'electron';
import { ipcMain, shell } from 'electron';
import { EcaServerStatus } from './server';
import type { ChatState} from './chat-state';
import { PENDING_CHAT_ID } from './chat-state';
import { getLogStore } from './log-store';
import type { RouteContext } from './router';
import { dispatch } from './router';
import type { IpcMessage, ToolServerUpdatedParams, ChatEntry, AskQuestionResult } from './protocol';
import * as rpc from './rpc';
import type { SessionManager, Session } from './session-manager';

// Track MCP server, config and providers state per session
const mcpServers = new Map<string, Record<string, ToolServerUpdatedParams>>();
const configCache = new Map<string, unknown>();
const providersCache = new Map<string, unknown>();

export function createBridge(
    mainWindow: BrowserWindow,
    sessionManager: SessionManager,
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
            // A content event that carries parentChatId can only belong to a
            // subagent — flag it up front so the sidebar never sees it, even
            // if the chat/opened that would normally flag it is late (e.g.
            // during a chat/open replay).
            if (params.parentChatId) {
                session.chatState.markAsSubagent(params.chatId);
            }

            session.chatState.pushContentEvent(params.chatId, params);

            // Update sidebar title when metadata arrives. addOrUpdateEntry is
            // a no-op for subagents, so we don't need an explicit guard here.
            const content = (params as Record<string, unknown>).content as
                | { type?: string; title?: string; id?: string; manualApproval?: boolean }
                | undefined;
            if (content?.type === 'metadata' && content.title) {
                session.chatState.addOrUpdateEntry(params.chatId, {
                    title: content.title,
                });
                sendChatListUpdate();
            }

            // Track tool-call manual-approval transitions so the sidebar can
            // flip the chat into the orange 'waiting-approval' state.
            //   - `toolCallRun` + manualApproval=true  → blocked on the user
            //   - `toolCallRunning` / `toolCallRejected` / `toolCalled` → unblock
            // Non-manual-approval runs never enter the pending set, so their
            // terminal events are harmless no-ops.
            if (content?.id) {
                if (content.type === 'toolCallRun' && content.manualApproval) {
                    session.chatState.markToolCallWaitingApproval(params.chatId, content.id);
                    sendChatListUpdate();
                } else if (
                    content.type === 'toolCallRunning' ||
                    content.type === 'toolCallRejected' ||
                    content.type === 'toolCalled'
                ) {
                    session.chatState.markToolCallNotWaitingApproval(params.chatId, content.id);
                    sendChatListUpdate();
                }
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

            // If we're deleting the chat the user is currently viewing, fall
            // forward to a sibling so they don't end up staring at an empty
            // chat panel. We capture sidebar order *before* removal so we can
            // pick the entry that takes the deleted slot's index — i.e. the
            // chat immediately below — and gracefully fall back to the one
            // above (idx-1) if the deleted chat was the bottom of the list.
            const wasSelected = session.chatState.selectedChatId === params.chatId;
            const before = wasSelected
                ? session.chatState.getChatListUpdate().entries
                    .filter(e => e.id !== PENDING_CHAT_ID)
                    .map(e => e.id)
                : [];
            const idx = wasSelected ? before.indexOf(params.chatId) : -1;

            session.chatState.removeEntry(params.chatId);

            if (wasSelected) {
                const after = session.chatState.getChatListUpdate().entries
                    .filter(e => e.id !== PENDING_CHAT_ID)
                    .map(e => e.id);
                const next = after[idx] ?? after[idx - 1] ?? null;
                if (next) {
                    selectChatInSession(session, next);
                    return;
                }
            }
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
                        // A chat being opened now is "fresh" — refresh the
                        // sidebar date so it sorts/displays correctly.
                        updatedAt: Date.now(),
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

        conn.onNotification(rpc.toolServerRemoved, (params) => {
            // Drop the entry from the session-scoped cache so later
            // rehydrations don't resurrect a server the user removed.
            // `Reflect.deleteProperty` satisfies
            // @typescript-eslint/no-dynamic-delete; the cache object
            // is captured by closure in other handlers so we can't
            // simply rebind it.
            Reflect.deleteProperty(sessionMcpServers, params.name);
            if (session.id === sessionManager.activeSessionId) {
                sendToRenderer('tool/serverRemoved', params);
                // Also re-broadcast the current list so any stale
                // consumers that ignore 'tool/serverRemoved' converge.
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

        // $/progress — server-emitted init-progress notifications. Forwarded
        // only for the active session so the webview's single shared store
        // isn't polluted by background sessions. See ProgressParams in
        // src/main/protocol.ts for the payload shape and the corresponding
        // eca-emacs handler (eca--handle-progress) for the expected
        // "N/M · title" rendering contract.
        conn.onNotification(rpc.progress, (params) => {
            if (session.id === sessionManager.activeSessionId) {
                sendToRenderer('$/progress', params);
            }
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
        // ── Logs (handled locally, no server connection required) ──
        //
        // These live before the session/conn check so the Logs tab stays
        // useful even when no session has been created yet — which is
        // precisely the moment users hit download / binary-not-found
        // failures they most want to inspect.
        if (message.type === 'logs/snapshot') {
            sendToRenderer('logs/snapshot', getLogStore().snapshot());
            return;
        }
        if (message.type === 'logs/clear') {
            getLogStore().clear();
            return;
        }
        if (message.type === 'logs/openFolder') {
            const file = getLogStore().logFilePath();
            if (file) {
                // `showItemInFolder` opens the OS file manager with the
                // log file pre-selected, which is friendlier than just
                // revealing the directory.
                shell.showItemInFolder(file);
            }
            return;
        }

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

    /**
     * Activate `session` and switch its current selection to `chatId`.
     *
     * Mirrors what the `chat-select` IPC handler does for a real (non-pending)
     * chat: makes the session active, marks the chat as selected, replays
     * session-scoped context (workspace, MCP, config, providers), hydrates
     * cold chats via `chat/open`, then notifies the renderer and refreshes
     * the sidebar. Extracted so callers other than the user-driven sidebar
     * click (e.g. auto-selecting a sibling after deletion) get the same
     * end-to-end behavior without duplication.
     */
    function selectChatInSession(session: Session, chatId: string): void {
        sessionManager.activeSessionId = session.id;
        session.chatState.selectedChatId = chatId;
        sendSessionContext(session);

        // Cold chat — loaded from chat/list but never opened in this client
        // run. Ask the server to replay chat/cleared + chat/opened +
        // chat/contentReceived so the existing notification handlers
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

        sendToRenderer('chat/selectChat', chatId);
        sendChatListUpdate();
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
            selectChatInSession(session, chatId);
        } else {
            // Session not found — at least keep the renderer in sync.
            sendToRenderer('chat/selectChat', chatId);
            sendChatListUpdate();
        }
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
