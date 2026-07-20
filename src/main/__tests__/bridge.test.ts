import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Electron mock ──
//
// We fake ipcMain as a minimal channel registry. bridge.ts registers
// several `ipcMain.on` handlers during createBridge; we capture them
// and invoke them directly in tests.
const ipcHandlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => void>());
const shellMock = vi.hoisted(() => ({
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
    ipcMain: {
        on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void): void => {
            ipcHandlers.set(channel, handler);
        },
    },
    shell: shellMock,
}));

// Stub the router so we can tell when it was called without actually
// exercising a real JSON-RPC connection.
const dispatchMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../router', () => ({ dispatch: dispatchMock }));

// log-store: the Logs tab handlers reach for this; keep it trivial.
vi.mock('../log-store', () => ({
    getLogStore: () => ({
        snapshot: () => [],
        clear: vi.fn(),
        logFilePath: () => null,
        append: vi.fn(),
    }),
}));

// EcaServer is only referenced for the EcaServerStatus enum; the
// session-manager mock provides its own stub.
vi.mock('../server', () => ({
    EcaServerStatus: {
        Stopped: 'Stopped',
        Starting: 'Starting',
        Initializing: 'Initializing',
        Running: 'Running',
        Failed: 'Failed',
    },
}));

import { createBridge, dropSessionCaches } from '../bridge';
import { CONTENT_BATCH_MS, CONTENT_BATCH_MAX_EVENTS } from '../constants';

// ── Test doubles ──

/**
 * Minimal stand-in for a vscode-jsonrpc MessageConnection. Records the
 * notification/request handlers the bridge registers (keyed by the rpc
 * type's `.method`) so tests can invoke them as if the server had sent
 * the notification.
 */
function makeFakeConnection() {
    const notificationHandlers = new Map<string, (params: never) => void>();
    return {
        onNotification: (type: { method: string }, handler: (params: never) => void): void => {
            notificationHandlers.set(type.method, handler);
        },
        onRequest: vi.fn(),
        sendRequest: vi.fn(async () => ({})),
        sendNotification: vi.fn(),
        /** Fire a fake server notification by method name. */
        notify: (method: string, params: unknown): void => {
            const handler = notificationHandlers.get(method);
            if (!handler) throw new Error(`no handler registered for ${method}`);
            handler(params as never);
        },
    };
}

interface FakeSession {
    id: string;
    workspaceFolder: { name: string; uri: string };
    ecaServer: {
        status: string;
        connection: unknown;
        onStatusChanged: (s: string) => void;
    };
    chatState: {
        rehydrate: ReturnType<typeof vi.fn>;
        getChatListUpdate: () => { entries: { id: string }[]; selectedId: null };
        removePendingChat: ReturnType<typeof vi.fn>;
        addPendingNewChat: ReturnType<typeof vi.fn>;
        pushContentEvent: ReturnType<typeof vi.fn>;
        markAsSubagent: ReturnType<typeof vi.fn>;
        isSubagent: () => boolean;
        addOrUpdateEntry: ReturnType<typeof vi.fn>;
        updateStatus: ReturnType<typeof vi.fn>;
        markToolCallWaitingApproval: ReturnType<typeof vi.fn>;
        markToolCallNotWaitingApproval: ReturnType<typeof vi.fn>;
        cachePayload: ReturnType<typeof vi.fn>;
        selectedChatId: string | null;
    };
}

function makeFakeSession(id = 's-1'): FakeSession {
    return {
        id,
        workspaceFolder: { name: 'demo', uri: 'file:///tmp/demo' },
        ecaServer: {
            status: 'Running',
            connection: {}, // any truthy value — router is mocked so we don't care
            onStatusChanged: () => {},
        },
        chatState: {
            rehydrate: vi.fn(),
            getChatListUpdate: () => ({ entries: [], selectedId: null }),
            removePendingChat: vi.fn(),
            addPendingNewChat: vi.fn(),
            pushContentEvent: vi.fn(),
            markAsSubagent: vi.fn(),
            isSubagent: () => false,
            addOrUpdateEntry: vi.fn(),
            updateStatus: vi.fn(),
            markToolCallWaitingApproval: vi.fn(),
            markToolCallNotWaitingApproval: vi.fn(),
            cachePayload: vi.fn(),
            selectedChatId: null,
        },
    };
}

function makeFakeSessionManager(sessions: FakeSession[] = []): EventEmitter & {
    getActiveSession: () => FakeSession | undefined;
    getAllSessions: () => FakeSession[];
    getSession: (id: string) => FakeSession | undefined;
    getSessionForChat: (id: string) => FakeSession | undefined;
    getSessionInfoList: () => { sessions: unknown[]; activeSessionId: string | null };
    activeSessionId: string | null;
} {
    const emitter = new EventEmitter();
    const api = Object.assign(emitter, {
        activeSessionId: sessions[0]?.id ?? null,
        getActiveSession: (): FakeSession | undefined => sessions.find((s) => s.id === api.activeSessionId),
        getAllSessions: (): FakeSession[] => sessions,
        getSession: (id: string): FakeSession | undefined => sessions.find((s) => s.id === id),
        getSessionForChat: (): FakeSession | undefined => undefined,
        getSessionInfoList: () => ({ sessions: [], activeSessionId: api.activeSessionId }),
    });
    return api;
}

function makeFakeMainWindow(id = 1): {
    isDestroyed: () => boolean;
    webContents: EventEmitter & {
        id: number;
        send: ReturnType<typeof vi.fn>;
    };
} {
    const webContents = Object.assign(new EventEmitter(), {
        id,
        send: vi.fn(),
    });
    return {
        isDestroyed: () => false,
        webContents,
    };
}

// ── Tests ──

describe('bridge', () => {
    beforeEach(() => {
        ipcHandlers.clear();
        dispatchMock.mockClear();
        dispatchMock.mockResolvedValue(true);
        shellMock.showItemInFolder.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('dropSessionCaches', () => {
        it('is exported and is a no-op on an unknown session id', () => {
            expect(typeof dropSessionCaches).toBe('function');
            expect(() => dropSessionCaches('never-existed')).not.toThrow();
        });
    });

    describe('IPC sender validation', () => {
        it('rejects webview-message IPC from an untrusted sender', async () => {
            const session = makeFakeSession();
            const sessionManager = makeFakeSessionManager([session]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            const handler = ipcHandlers.get('webview-message');
            expect(handler).toBeDefined();

            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // Simulate an event originating from a *different* webContents id
            const untrustedEvent = { sender: { id: 99 } };
            await handler!(untrustedEvent, { type: 'chat/promptStop', data: { chatId: 'x' } });

            expect(dispatchMock).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('untrusted sender'),
                99,
            );
            warn.mockRestore();
        });

        it('rejects malformed payloads from a trusted sender', async () => {
            const session = makeFakeSession();
            const sessionManager = makeFakeSessionManager([session]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            const handler = ipcHandlers.get('webview-message');
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const event = { sender: { id: 1 } };

            await handler!(event, null);
            await handler!(event, { type: 42, data: {} });
            await handler!(event, 'not an object');

            expect(dispatchMock).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        it('dispatches messages from a trusted sender', async () => {
            const session = makeFakeSession();
            const sessionManager = makeFakeSessionManager([session]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            const handler = ipcHandlers.get('webview-message');
            const event = { sender: { id: 1 } };
            await handler!(event, { type: 'chat/promptStop', data: { chatId: 'x' } });

            expect(dispatchMock).toHaveBeenCalledOnce();
        });
    });

    describe('logs/* IPC handlers', () => {
        it('does not require an active session for logs/snapshot', async () => {
            const sessionManager = makeFakeSessionManager([]); // no sessions!
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            const handler = ipcHandlers.get('webview-message')!;
            const event = { sender: { id: 1 } };

            // Should not throw and should NOT invoke dispatch.
            await handler(event, { type: 'logs/snapshot', data: {} });
            expect(dispatchMock).not.toHaveBeenCalled();
        });
    });

    describe('session-removed event handler', () => {
        it('drops session-scoped caches on session-removed (observable via rehydration)', () => {
            const session = makeFakeSession('s-A');
            const sessionManager = makeFakeSessionManager([session]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            // Emit session-removed — should simply not throw even when
            // caches are empty. Without a fake JSON-RPC connection we
            // can't populate the caches from inside the bridge, but
            // the listener is wired and calling dropSessionCaches on
            // an unknown id is a safe no-op.
            expect(() => {
                sessionManager.emit('session-removed', 's-A');
            }).not.toThrow();

            // Subsequent calls are idempotent (map.delete on missing
            // key is a no-op) — verifies the handler doesn't leave the
            // module in a wedged state.
            expect(() => {
                sessionManager.emit('session-removed', 's-A');
            }).not.toThrow();
        });
    });

    describe('sidebar IPC registration', () => {
        it('registers chat-select, chat-new, chat-delete channels', () => {
            const sessionManager = makeFakeSessionManager([]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            expect(ipcHandlers.has('webview-message')).toBe(true);
            expect(ipcHandlers.has('chat-select')).toBe(true);
            expect(ipcHandlers.has('chat-new')).toBe(true);
            expect(ipcHandlers.has('chat-delete')).toBe(true);
        });
    });

    describe('did-finish-load rehydration', () => {
        it('invokes chatState.rehydrate on every session after the main window finishes loading', () => {
            const s1 = makeFakeSession('s-1');
            const s2 = makeFakeSession('s-2');
            const sessionManager = makeFakeSessionManager([s1, s2]);
            sessionManager.activeSessionId = 's-1';
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            // Simulate the webContents 'did-finish-load' event
            mainWindow.webContents.emit('did-finish-load');

            expect(s1.chatState.rehydrate).toHaveBeenCalledOnce();
            expect(s2.chatState.rehydrate).toHaveBeenCalledOnce();
        });
    });

    describe('createBridge return value', () => {
        it('exposes registerServerNotifications, sendSessionListUpdate, sendChatListUpdate, loadSessionChats', () => {
            const sessionManager = makeFakeSessionManager([]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const api = createBridge(mainWindow as any, sessionManager as any);

            expect(typeof api.registerServerNotifications).toBe('function');
            expect(typeof api.sendSessionListUpdate).toBe('function');
            expect(typeof api.sendChatListUpdate).toBe('function');
            expect(typeof api.loadSessionChats).toBe('function');
        });
    });

    describe('content-event batching (issue #11)', () => {
        function serverMessages(mainWindow: ReturnType<typeof makeFakeMainWindow>): { type: string; data: unknown }[] {
            return mainWindow.webContents.send.mock.calls
                .filter(([channel]) => channel === 'server-message')
                .map(([, payload]) => payload as { type: string; data: unknown });
        }

        function contentEvent(i: number): unknown {
            return { chatId: 'c-1', role: 'assistant', content: { type: 'text', text: `t${i}` } };
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        function setup() {
            const session = makeFakeSession('s-1');
            const conn = makeFakeConnection();
            session.ecaServer.connection = conn;
            const sessionManager = makeFakeSessionManager([session]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bridge = createBridge(mainWindow as any, sessionManager as any);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bridge.registerServerNotifications(session as any);
            return { session, conn, mainWindow };
        }

        it('coalesces a burst of chat/contentReceived into one chat/batchContentReceived', () => {
            const { conn, mainWindow } = setup();

            for (let i = 0; i < 5; i++) {
                conn.notify('chat/contentReceived', contentEvent(i));
            }

            // Nothing forwarded yet — the flush timer is pending.
            expect(serverMessages(mainWindow)).toHaveLength(0);

            vi.advanceTimersByTime(CONTENT_BATCH_MS + 1);

            const msgs = serverMessages(mainWindow);
            expect(msgs).toHaveLength(1);
            expect(msgs[0].type).toBe('chat/batchContentReceived');
            expect(msgs[0].data).toHaveLength(5);
        });

        it('flushes buffered content before any other message so ordering is preserved', () => {
            const { conn, mainWindow } = setup();

            conn.notify('chat/contentReceived', contentEvent(0));
            conn.notify('chat/contentReceived', contentEvent(1));
            conn.notify('chat/statusChanged', { chatId: 'c-1', status: 'idle' });

            const msgs = serverMessages(mainWindow);
            expect(msgs.map((m) => m.type)).toEqual([
                'chat/batchContentReceived',
                'chat/statusChanged',
            ]);
            expect(msgs[0].data).toHaveLength(2);
        });

        it('flushes immediately when the buffer reaches CONTENT_BATCH_MAX_EVENTS', () => {
            const { conn, mainWindow } = setup();

            for (let i = 0; i < CONTENT_BATCH_MAX_EVENTS; i++) {
                conn.notify('chat/contentReceived', contentEvent(i));
            }

            // No timer advance needed — the cap forces the flush.
            const msgs = serverMessages(mainWindow);
            expect(msgs).toHaveLength(1);
            expect(msgs[0].type).toBe('chat/batchContentReceived');
            expect(msgs[0].data).toHaveLength(CONTENT_BATCH_MAX_EVENTS);
        });

        it('drops the buffer on did-finish-load instead of double-applying via rehydrate', () => {
            const { conn, mainWindow } = setup();

            conn.notify('chat/contentReceived', contentEvent(0));
            mainWindow.webContents.emit('did-finish-load');
            vi.advanceTimersByTime(CONTENT_BATCH_MS + 1);

            // The buffered event must NOT surface as a live batch — it is
            // already part of the rehydration cache replayed by rehydrate().
            const batches = serverMessages(mainWindow)
                .filter((m) => m.type === 'chat/batchContentReceived');
            expect(batches).toHaveLength(0);
        });
    });

    describe('chat-scoped session routing', () => {
        it('routes chat/promptStop to the session that owns the chat, not the active one', async () => {
            const active = makeFakeSession('s-active');
            const owner = makeFakeSession('s-owner');
            const ownerConn = makeFakeConnection();
            owner.ecaServer.connection = ownerConn;
            const sessionManager = makeFakeSessionManager([active, owner]);
            sessionManager.activeSessionId = 's-active';
            sessionManager.getSessionForChat = (chatId: string) =>
                chatId === 'chat-b' ? owner : undefined;
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            const handler = ipcHandlers.get('webview-message')!;
            await handler({ sender: { id: 1 } }, { type: 'chat/promptStop', data: { chatId: 'chat-b' } });

            expect(dispatchMock).toHaveBeenCalledOnce();
            const ctx = (dispatchMock.mock.calls[0] as unknown[])[0] as { conn: unknown };
            expect(ctx.conn).toBe(ownerConn);
        });

        it('falls back to the active session for unknown chat ids', async () => {
            const active = makeFakeSession('s-active');
            const activeConn = makeFakeConnection();
            active.ecaServer.connection = activeConn;
            const sessionManager = makeFakeSessionManager([active]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            createBridge(mainWindow as any, sessionManager as any);

            const handler = ipcHandlers.get('webview-message')!;
            await handler({ sender: { id: 1 } }, { type: 'chat/promptStop', data: { chatId: 'brand-new-uuid' } });

            expect(dispatchMock).toHaveBeenCalledOnce();
            const ctx = (dispatchMock.mock.calls[0] as unknown[])[0] as { conn: unknown };
            expect(ctx.conn).toBe(activeConn);
        });
    });

    describe('not-ready message queueing', () => {
        function setupStartingSession() {
            const session = makeFakeSession('s-1');
            session.ecaServer.status = 'Starting';
            session.ecaServer.connection = makeFakeConnection();
            const sessionManager = makeFakeSessionManager([session]);
            const mainWindow = makeFakeMainWindow(1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bridge = createBridge(mainWindow as any, sessionManager as any);
            // Installs the bridge's onStatusChanged (the one that flushes).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bridge.registerServerNotifications(session as any);
            const handler = ipcHandlers.get('webview-message')!;
            return { session, sessionManager, mainWindow, handler };
        }

        it('queues messages while the server is starting and replays them on Running', async () => {
            const { session, handler } = setupStartingSession();
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});

            await handler({ sender: { id: 1 } }, { type: 'providers/list', data: { requestId: 'r-1' } });
            expect(dispatchMock).not.toHaveBeenCalled();

            // Server finishes initializing
            session.ecaServer.status = 'Running';
            session.ecaServer.onStatusChanged('Running');

            await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledOnce());
            const [, msg] = dispatchMock.mock.calls[0] as unknown[];
            expect(msg).toEqual({ type: 'providers/list', data: { requestId: 'r-1' } });
            log.mockRestore();
        });

        it('replays queued messages in arrival order', async () => {
            const { session, handler } = setupStartingSession();
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});

            await handler({ sender: { id: 1 } }, { type: 'providers/list', data: { requestId: 'r-1' } });
            await handler({ sender: { id: 1 } }, { type: 'jobs/list', data: { requestId: 'r-2' } });

            session.ecaServer.status = 'Running';
            session.ecaServer.onStatusChanged('Running');

            await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(2));
            const types = dispatchMock.mock.calls.map((c) => ((c as unknown[])[1] as { type: string }).type);
            expect(types).toEqual(['providers/list', 'jobs/list']);
            log.mockRestore();
        });

        it('still serves webview/ready while the server is starting', async () => {
            const { session, handler } = setupStartingSession();

            await handler({ sender: { id: 1 } }, { type: 'webview/ready', data: {} });

            // Rehydration ran immediately — not queued.
            expect(session.chatState.rehydrate).toHaveBeenCalledOnce();

            session.ecaServer.status = 'Running';
            session.ecaServer.onStatusChanged('Running');
            await new Promise((r) => setTimeout(r, 0));

            // Nothing was queued, so nothing is dispatched on flush.
            expect(dispatchMock).not.toHaveBeenCalled();
        });

        it('drops the queue when the session is removed', async () => {
            const { session, sessionManager, handler } = setupStartingSession();
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});

            await handler({ sender: { id: 1 } }, { type: 'providers/list', data: { requestId: 'r-1' } });
            sessionManager.emit('session-removed', 's-1');

            session.ecaServer.status = 'Running';
            session.ecaServer.onStatusChanged('Running');
            await new Promise((r) => setTimeout(r, 0));

            expect(dispatchMock).not.toHaveBeenCalled();
            log.mockRestore();
        });
    });
});
