import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──
//
// SessionManager does `new EcaServer(...)` internally; stub it so we
// don't pull in child_process / rpc transitively.

const stopMock = vi.fn();

vi.mock('../server', () => {
    class EcaServer {
        status = 'Stopped';
        connection = null;
        onLog: (msg: string) => void = () => {};
        onStatusChanged: (s: string) => void = () => {};
        onConnectionReady: () => void = () => {};
        stop = stopMock;
    }
    return {
        EcaServer,
        EcaServerStatus: {
            Stopped: 'Stopped',
            Starting: 'Starting',
            Initializing: 'Initializing',
            Running: 'Running',
            Failed: 'Failed',
        },
    };
});

// LogStore singleton is touched inside createSession. Route it to a
// no-op so we don't try to init the real Electron-dependent singleton.
vi.mock('../log-store', () => ({
    getLogStore: () => ({ append: vi.fn() }),
}));

vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
}));

import { SessionManager } from '../session-manager';
import type { WorkspaceFolder } from '../protocol';

const folder: WorkspaceFolder = { name: 'demo', uri: 'file:///tmp/demo' };

describe('SessionManager', () => {
    let mgr: SessionManager;

    beforeEach(() => {
        stopMock.mockReset();
        stopMock.mockResolvedValue(undefined);
        mgr = new SessionManager();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('createSession', () => {
        it('emits session-created and stores the session by id', () => {
            const listener = vi.fn();
            mgr.on('session-created', listener);

            const session = mgr.createSession(folder);

            expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(session.workspaceFolder).toEqual(folder);
            expect(listener).toHaveBeenCalledOnce();
            expect(listener.mock.calls[0][0]).toBe(session);
            expect(mgr.getSession(session.id)).toBe(session);
        });

        it('assigns distinct UUIDs to each session', () => {
            const a = mgr.createSession(folder);
            const b = mgr.createSession({ name: 'other', uri: 'file:///tmp/o' });
            expect(a.id).not.toBe(b.id);
            expect(mgr.getAllSessions()).toHaveLength(2);
        });
    });

    describe('activeSessionId', () => {
        it('is null initially', () => {
            expect(mgr.activeSessionId).toBeNull();
            expect(mgr.getActiveSession()).toBeUndefined();
        });

        it('get/set round-trips and drives getActiveSession', () => {
            const s = mgr.createSession(folder);
            mgr.activeSessionId = s.id;
            expect(mgr.activeSessionId).toBe(s.id);
            expect(mgr.getActiveSession()).toBe(s);
        });
    });

    describe('getSessionForChat', () => {
        it('finds the session whose chat state contains the id', () => {
            const s1 = mgr.createSession(folder);
            const s2 = mgr.createSession({ name: 'other', uri: 'file:///o' });

            s1.chatState.addOrUpdateEntry('chat-in-s1', { title: 't' });
            s2.chatState.addOrUpdateEntry('chat-in-s2', { title: 't' });

            expect(mgr.getSessionForChat('chat-in-s1')).toBe(s1);
            expect(mgr.getSessionForChat('chat-in-s2')).toBe(s2);
            expect(mgr.getSessionForChat('nope')).toBeUndefined();
        });
    });

    describe('removeSession', () => {
        it('awaits ecaServer.stop() before removing (fake-timer advance)', async () => {
            vi.useFakeTimers();

            let resolveStop!: () => void;
            stopMock.mockImplementation(
                () => new Promise<void>((resolve) => { resolveStop = resolve; }),
            );

            const s = mgr.createSession(folder);
            const removeP = mgr.removeSession(s.id);

            // Microtask for the await, but stop hasn't resolved yet:
            await Promise.resolve();
            expect(mgr.getSession(s.id)).toBe(s);

            resolveStop();
            await removeP;

            expect(mgr.getSession(s.id)).toBeUndefined();
            expect(stopMock).toHaveBeenCalledOnce();
        });

        it('still removes the session and emits session-removed when stop() rejects', async () => {
            stopMock.mockRejectedValue(new Error('server hung'));
            const listener = vi.fn();
            mgr.on('session-removed', listener);

            // Swallow the expected console.error from SessionManager.
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            const s = mgr.createSession(folder);
            await mgr.removeSession(s.id);

            expect(mgr.getSession(s.id)).toBeUndefined();
            expect(listener).toHaveBeenCalledWith(s.id);
            errSpy.mockRestore();
        });

        it('falls activeSessionId over to a remaining session', async () => {
            const s1 = mgr.createSession(folder);
            const s2 = mgr.createSession({ name: 'other', uri: 'file:///o' });
            mgr.activeSessionId = s1.id;

            await mgr.removeSession(s1.id);

            expect(mgr.activeSessionId).toBe(s2.id);
        });

        it('sets activeSessionId to null when removing the last session', async () => {
            const s = mgr.createSession(folder);
            mgr.activeSessionId = s.id;

            await mgr.removeSession(s.id);

            expect(mgr.activeSessionId).toBeNull();
        });

        it('is a no-op when the id is unknown', async () => {
            const listener = vi.fn();
            mgr.on('session-removed', listener);
            await mgr.removeSession('nope');
            expect(listener).not.toHaveBeenCalled();
            expect(stopMock).not.toHaveBeenCalled();
        });
    });

    describe('getSessionInfoList', () => {
        it('summarizes every session with status and active id', () => {
            const s = mgr.createSession(folder);
            mgr.activeSessionId = s.id;
            const info = mgr.getSessionInfoList();
            expect(info.activeSessionId).toBe(s.id);
            expect(info.sessions).toHaveLength(1);
            expect(info.sessions[0]).toMatchObject({
                id: s.id,
                workspaceFolder: folder,
                status: 'Stopped',
            });
        });
    });

    describe('getAggregatedChatList', () => {
        it('concatenates entries across sessions', () => {
            const s1 = mgr.createSession(folder);
            const s2 = mgr.createSession({ name: 'other', uri: 'file:///o' });
            s1.chatState.addOrUpdateEntry('a', { title: 'A' });
            s2.chatState.addOrUpdateEntry('b', { title: 'B' });

            const out = mgr.getAggregatedChatList();
            const ids = out.entries.map((e) => e.id).sort();
            expect(ids).toEqual(['a', 'b']);
        });
    });
});
