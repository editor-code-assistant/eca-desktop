// ============================================================
// Session manager — orchestrates multiple ECA sessions
// ============================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { EcaServer } from './server';
import { ChatState } from './chat-state';
import { getLogStore } from './log-store';
import type { PreferencesStore } from './preferences-store';
import type { WorkspaceFolder, ChatEntry, SessionInfo, SessionListUpdate } from './protocol';

export interface Session {
    id: string;
    workspaceFolder: WorkspaceFolder;
    ecaServer: EcaServer;
    chatState: ChatState;
}

export class SessionManager extends EventEmitter {
    private sessions = new Map<string, Session>();
    private _activeSessionId: string | null = null;

    constructor(private preferencesStore?: PreferencesStore) {
        super();
    }

    get activeSessionId(): string | null {
        return this._activeSessionId;
    }

    set activeSessionId(id: string | null) {
        this._activeSessionId = id;
    }

    getActiveSession(): Session | undefined {
        if (!this._activeSessionId) return undefined;
        return this.sessions.get(this._activeSessionId);
    }

    createSession(workspaceFolder: WorkspaceFolder): Session {
        const id = crypto.randomUUID();
        const ecaServer = new EcaServer(this.preferencesStore);

        // Route every `onLog` line (stderr chunks + lifecycle messages
        // emitted by EcaServer itself) into the central LogStore so the
        // Logs UI and the on-disk `eca-server.log` both receive them.
        const logStore = getLogStore();
        ecaServer.onLog = (msg: string) => {
            logStore.append({ sessionId: id, source: 'server', text: msg });
        };

        const chatState = new ChatState([workspaceFolder]);

        const session: Session = { id, workspaceFolder, ecaServer, chatState };
        this.sessions.set(id, session);
        this.emit('session-created', session);
        return session;
    }

    async removeSession(id: string): Promise<void> {
        const session = this.sessions.get(id);
        if (!session) return;

        try {
            await session.ecaServer.stop();
        } catch (err) {
            console.error('[SessionManager] Error stopping server for session', id, err);
            // Swallow: we still want to remove the session from the map
            // even if server shutdown fails, so we don't leak state.
        }

        this.sessions.delete(id);
        this.emit('session-removed', id);

        if (this._activeSessionId === id) {
            const remaining = Array.from(this.sessions.keys());
            this._activeSessionId = remaining.length > 0 ? remaining[0] : null;
        }
    }

    getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    getAllSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    getSessionForChat(chatId: string): Session | undefined {
        for (const session of this.sessions.values()) {
            const { entries } = session.chatState.getChatListUpdate();
            if (entries.some((entry) => entry.id === chatId)) {
                return session;
            }
        }
        return undefined;
    }

    getAggregatedChatList(): { entries: ChatEntry[]; activeSessionId: string | null } {
        const allEntries: ChatEntry[] = [];
        for (const session of this.sessions.values()) {
            const { entries } = session.chatState.getChatListUpdate();
            allEntries.push(...entries);
        }
        return { entries: allEntries, activeSessionId: this._activeSessionId };
    }

    getSessionInfoList(): SessionListUpdate {
        const sessions: SessionInfo[] = Array.from(this.sessions.values()).map((session) => ({
            id: session.id,
            workspaceFolder: session.workspaceFolder,
            status: session.ecaServer.status,
        }));
        return { sessions, activeSessionId: this._activeSessionId };
    }
}
