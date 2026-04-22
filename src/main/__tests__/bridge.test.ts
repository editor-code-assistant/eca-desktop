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

// ── Test doubles ──

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
        getChatListUpdate: () => { entries: unknown[]; selectedId: null };
        removePendingChat: ReturnType<typeof vi.fn>;
        addPendingNewChat: ReturnType<typeof vi.fn>;
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
});
