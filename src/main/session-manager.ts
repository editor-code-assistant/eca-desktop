// ============================================================
// Session manager — orchestrates multiple ECA sessions
// ============================================================

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { EcaServer, EcaServerStatus } from './server';
import { ChatState } from './chat-state';
import { WorkspaceFolder, ChatEntry, SessionInfo, SessionListUpdate, RecentWorkspace } from './protocol';

export interface Session {
    id: string;
    workspaceFolder: WorkspaceFolder;
    ecaServer: EcaServer;
    chatState: ChatState;
}

export class SessionManager extends EventEmitter {
    private sessions = new Map<string, Session>();
    private _activeSessionId: string | null = null;

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
        const ecaServer = new EcaServer();
        const chatState = new ChatState([workspaceFolder]);

        const session: Session = { id, workspaceFolder, ecaServer, chatState };
        this.sessions.set(id, session);
        this.emit('session-created', session);
        return session;
    }

    removeSession(id: string): void {
        const session = this.sessions.get(id);
        if (!session) return;

        session.ecaServer.stop();
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
