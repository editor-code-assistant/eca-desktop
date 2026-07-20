// ============================================================
// Bridge — thin orchestrator wiring IPC, router, and chat state
// ============================================================

import type { BrowserWindow, IpcMainEvent} from 'electron';
import { ipcMain, shell } from 'electron';
import { EcaServerStatus } from './server';
import type { ChatState} from './chat-state';
import { PENDING_CHAT_ID } from './chat-state';
import { getLogStore } from './log-store';
import type { RouteContext } from './router';
import { dispatch } from './router';
import type { IpcMessage, ToolServerUpdatedParams, ChatEntry, ChatContentReceivedParams, AskQuestionResult } from './protocol';
import * as rpc from './rpc';
import type { SessionManager, Session } from './session-manager';
import { CONTENT_BATCH_MS, CONTENT_BATCH_MAX_EVENTS } from './constants';

// Track MCP server, config and providers state per session. Cleaned up
// in `dropSessionCaches` when a session is removed, so long-running
// users aren't bleeding one entry per closed workspace forever.
//
// `configCache` stores the cumulative GLOBAL (unscoped) session config —
// merged across successive `config/updated` notifications so partial
// updates (e.g. a single `chat.selectModel` change) don't clobber the
// `chat.models` / `chat.agents` / `chat.variants` arrays that arrived
// in earlier full updates. Per-chat scoped updates (those with a
// top-level `chatId`) are stored separately in `perChatConfigCache`
// and replayed after `chatState.rehydrate` on `webview/ready`.
const mcpServers = new Map<string, Record<string, ToolServerUpdatedParams>>();
const configCache = new Map<string, unknown>();
const perChatConfigCache = new Map<string, Map<string, unknown>>();
const providersCache = new Map<string, unknown>();

export function dropSessionCaches(sessionId: string): void {
    mcpServers.delete(sessionId);
    configCache.delete(sessionId);
    perChatConfigCache.delete(sessionId);
    providersCache.delete(sessionId);
}

/**
 * Verify an incoming IPC message originated from the main window's
 * `webContents`. This is a WebContents-level check — it compares
 * `event.sender.id` against `mainWindow.webContents.id`, so any frame
 * (top or sub) hosted by the main window will pass. In the current
 * architecture no sub-frames are ever loaded, and the combination of
 * `sandbox: true` + `contextIsolation: true` + `webSecurity: true` +
 * our strict CSP means a rogue cross-origin iframe could not inherit
 * the preload API even if one were injected. So this is a pragmatic
 * first line of defense, not a top-frame guarantee.
 *
 * TODO(post-launch): strengthen to
 *   `event.senderFrame === event.sender.mainFrame`
 * once we've verified Electron 33+ `WebFrameMain` semantics. See the
 * code-review H-2 finding for the rationale.
 */
function isTrustedSender(event: IpcMainEvent, mainWindow: BrowserWindow): boolean {
    if (mainWindow.isDestroyed()) return false;
    const senderId = event.sender.id;
    const mainId = mainWindow.webContents.id;
    return senderId === mainId;
}

export function createBridge(
    mainWindow: BrowserWindow,
    sessionManager: SessionManager,
) {
    // Evict session-scoped caches when a session is torn down. Without
    // this, long-running users bleed one { mcpServers, configCache,
    // providersCache } entry per closed workspace forever. See audit
    // finding "bridge module-level Maps never evicted".
    sessionManager.on('session-removed', (sessionId: string) => {
        dropSessionCaches(sessionId);
    });

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

    function rawSendToRenderer(type: string, data: unknown): void {
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server-message', { type, data });
        }
    }

    // ── Content-event coalescing (issue #11) ──
    //
    // High-frequency `chat/contentReceived` notifications are buffered
    // and flushed as a single `chat/batchContentReceived` — a message
    // the webview already consumes with one Redux dispatch / one React
    // render (it powers rehydration). This keeps the renderer's main
    // thread responsive during fast streaming so user input (e.g. the
    // Stop button) is processed promptly instead of queueing behind
    // one render per streamed token.
    //
    // Ordering: every non-content send flushes the buffer first, so a
    // `chat/statusChanged`, `chat/askQuestion`, etc. can never overtake
    // content that arrived before it. Order within the buffer is
    // arrival order, and the webview's batch reducer applies events
    // sequentially — identical semantics to per-event delivery.
    let pendingContentEvents: ChatContentReceivedParams[] = [];
    let contentFlushTimer: NodeJS.Timeout | null = null;

    function flushContentEvents(): void {
        if (contentFlushTimer) {
            clearTimeout(contentFlushTimer);
            contentFlushTimer = null;
        }
        if (pendingContentEvents.length === 0) return;
        const batch = pendingContentEvents;
        pendingContentEvents = [];
        rawSendToRenderer('chat/batchContentReceived', batch);
    }

    // Rehydration replays the FULL `chatState.contentEvents` cache, and
    // every buffered event has already been pushed to that cache by the
    // `chat/contentReceived` notification handler. Flushing the buffer
    // into a page that is about to be rehydrated would apply those
    // events twice (the webview's replay path doesn't reset messages),
    // so both rehydration paths discard the buffer instead.
    function discardPendingContentEvents(): void {
        if (contentFlushTimer) {
            clearTimeout(contentFlushTimer);
            contentFlushTimer = null;
        }
        pendingContentEvents = [];
    }

    function sendToRenderer(type: string, data: unknown): void {
        if (type === 'chat/contentReceived') {
            pendingContentEvents.push(data as ChatContentReceivedParams);
            if (pendingContentEvents.length >= CONTENT_BATCH_MAX_EVENTS) {
                flushContentEvents();
            } else if (!contentFlushTimer) {
                contentFlushTimer = setTimeout(flushContentEvents, CONTENT_BATCH_MS);
            }
            return;
        }
        flushContentEvents();
        rawSendToRenderer(type, data);
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
        // The page was just (re)loaded — anything still buffered will be
        // replayed from the rehydration cache below; see
        // discardPendingContentEvents.
        discardPendingContentEvents();
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
            // Replay messages that arrived while the server was starting
            // (e.g. a providers/list from an early-opened Settings tab).
            if (status === EcaServerStatus.Running) {
                void flushNotReadyQueue(session.id);
            }
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
            // The server emits two flavours of `config/updated`:
            //
            //   (a) unscoped/global — the initial post-`initialize` push
            //       carrying `chat: { models, agents, variants,
            //       selectModel, selectAgent, … }`, plus incremental
            //       global partials (e.g. just `chat.selectModel` on a
            //       session-default change).
            //
            //   (b) per-chat scoped — emitted as the last step of the
            //       `chat/open` cascade (see protocol.ts) and on
            //       `chat/selected*Changed`. These carry a top-level
            //       `chatId` plus only the per-chat fields
            //       (`selectModel` / `selectTrust` / etc.) — they do
            //       NOT include the `models` / `agents` / `variants`
            //       arrays the selectors need.
            //
            // Mixing the two into a single cache (the previous
            // `configCache.set(..., params)`) meant the very first
            // chat selection would clobber the cumulative global cache
            // with a stripped-down per-chat payload, and Ctrl+R would
            // re-send that payload on `webview/ready` — leaving the
            // model / agent / variant selectors empty because the
            // renderer's `setConfig` reducer treats undefined fields
            // as "leave alone".
            const p = params as { chatId?: string; chat?: Record<string, unknown> } & Record<string, unknown>;
            if (p.chatId) {
                let perChat = perChatConfigCache.get(session.id);
                if (!perChat) {
                    perChat = new Map();
                    perChatConfigCache.set(session.id, perChat);
                }
                perChat.set(p.chatId, params);
            } else {
                // Merge (not overwrite) — incremental global updates must
                // preserve fields carried by earlier full updates.
                const existing = (configCache.get(session.id) ?? {}) as Record<string, unknown>;
                const existingChat = (existing.chat as Record<string, unknown> | undefined) ?? {};
                const incomingChat = (p.chat as Record<string, unknown> | undefined) ?? {};
                const merged: Record<string, unknown> = {
                    ...existing,
                    ...p,
                    chat: { ...existingChat, ...incomingChat },
                };
                configCache.set(session.id, merged);
            }
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
        //
        // We also hand the params to the EcaServer so it can update its
        // init-task tracker and drive the Initializing → Running
        // transition once every task has reached its matching `finish`.
        // Doing this in the main process (instead of relying on the
        // renderer) keeps the lifecycle state machine co-located with
        // the JSON-RPC connection that owns it and lets the
        // `webview-message` drop-gate correctly reject prompts until
        // init completes — even if the webview is reloading or a
        // $/progress notification lands between IPC boundaries.
        conn.onNotification(rpc.progress, (params) => {
            session.ecaServer.recordInitProgress(params);
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

    // Messages that arrive while the session's server is still starting
    // (status != Running) are queued here and replayed — in order,
    // through the same processing path — once the server reports
    // Running (see registerServerNotifications). Dropping them instead
    // used to leave request/response flows hanging: e.g. opening
    // Settings → Providers during startup dropped `providers/list` and
    // the webview waited 30s for a reply that never came. The webview's
    // own webviewSendAndGet timeout bounds the staleness of anything
    // queued for too long.
    const notReadyQueue = new Map<string, IpcMessage[]>();
    const MAX_QUEUED_MESSAGES = 50;

    sessionManager.on('session-removed', (sessionId: string) => {
        notReadyQueue.delete(sessionId);
    });

    function queueNotReadyMessage(sessionId: string, message: IpcMessage): void {
        const queue = notReadyQueue.get(sessionId) ?? [];
        if (queue.length >= MAX_QUEUED_MESSAGES) {
            console.warn('[Bridge] Server not ready and queue full, dropping message:', message.type);
            return;
        }
        queue.push(message);
        notReadyQueue.set(sessionId, queue);
        console.log('[Bridge] Server not ready, queueing message:', message.type);
    }

    async function flushNotReadyQueue(sessionId: string): Promise<void> {
        const queued = notReadyQueue.get(sessionId);
        if (!queued || queued.length === 0) return;
        notReadyQueue.delete(sessionId);
        console.log(`[Bridge] Server ready, replaying ${queued.length} queued message(s)`);
        for (const message of queued) {
            // Sequential to preserve order. If the server flapped back
            // to not-Running mid-flush, messages re-queue for the next
            // Running transition (no loop: flush only runs on transition).
            await processWebviewMessage(message);
        }
    }

    ipcMain.on('webview-message', async (event, message: IpcMessage) => {
        // Defense-in-depth: only accept webview-message IPC from our own
        // main window's webContents. Blocks any loaded frame / popup /
        // iframe from impersonating the webview.
        if (!isTrustedSender(event, mainWindow)) {
            console.warn('[Bridge] Rejected webview-message from untrusted sender:', event.sender.id);
            return;
        }

        // Validate payload shape — avoid crashing on malformed IPC that
        // slipped past the preload contract.
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
            console.warn('[Bridge] Rejected malformed webview-message payload');
            return;
        }

        await processWebviewMessage(message);
    });

    async function processWebviewMessage(message: IpcMessage): Promise<void> {
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

        // Route chat-scoped messages to the session that OWNS the chat,
        // falling back to the active session (covers brand-new chats whose
        // client-minted id no session knows yet, and non-chat messages).
        // With multiple workspaces open, a `chat/promptStop` (or tool
        // approve/reject/steer) for a chat generating in a background
        // session must reach THAT session's server — the active one would
        // silently no-op it since it doesn't know the chatId (issue #11).
        const msgChatId = (message.data as { chatId?: unknown } | undefined)?.chatId;
        const session = (typeof msgChatId === 'string'
            ? sessionManager.getSessionForChat(msgChatId)
            : undefined) ?? getActiveSession();

        if (!session) {
            console.error('[Bridge] No active session, dropping message:', message.type);
            return;
        }

        const conn = session.ecaServer.connection ?? null;

        // Not ready yet (still spawning / initializing, or the connection
        // isn't even up) — queue for replay on the Running transition.
        // `webview/ready` is exempt: rehydration works during startup.
        if (message.type !== 'webview/ready'
            && (!conn || session.ecaServer.status !== EcaServerStatus.Running)) {
            queueNotReadyMessage(session.id, message);
            return;
        }

        if (!conn) {
            console.error('[Bridge] No active server connection, dropping message:', message.type);
            return;
        }

        const ctx: RouteContext = {
            conn,
            sendToRenderer,
            mainWindow,
            chatState: session.chatState,
            workspaceFolders: [session.workspaceFolder],
        };

        try {
            if (message.type === 'webview/ready') {
                // Full rehydration on every webview load — covers fresh
                // mount AND Ctrl+R / window.location.reload(). Fires
                // from a React useEffect, so the renderer's
                // `window.addEventListener('message', …)` handlers are
                // guaranteed attached by the time this lands. That's the
                // silent race the `did-finish-load` path is subject to,
                // which is why selectors came back empty after Ctrl+R.
                //
                // Drop (don't flush) any buffered content events first —
                // they are already in the rehydration cache replayed
                // below, and flushing them here would double-apply them.
                discardPendingContentEvents();
                sendSessionContext(session);
                session.chatState.rehydrate(sendToRenderer, [session.workspaceFolder]);
                // After the chats are open in the webview, replay any
                // per-chat `config/updated` overrides so each chat's
                // selectedModel / selectTrust survives the reload. The
                // applyConfigToChat reducer is a no-op for chats that
                // aren't in the slice yet, so order vs. rehydrate is
                // safe either way — we replay after to minimise wasted
                // work on chats the user never opened.
                const perChatConfigs = perChatConfigCache.get(session.id);
                if (perChatConfigs) {
                    for (const config of perChatConfigs.values()) {
                        sendToRenderer('config/updated', config);
                    }
                }
                sendChatListUpdate();
                sendSessionListUpdate();
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
    }

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
