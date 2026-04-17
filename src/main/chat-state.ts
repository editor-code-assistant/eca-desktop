// ============================================================
// Chat state management — sidebar entries + rehydration cache
// ============================================================

import { BrowserWindow } from 'electron';
import { ChatEntry, ChatOpenedParams, ChatContentReceivedParams, ChatSummary, WorkspaceFolder } from './protocol';

/** Sentinel ID for the placeholder "New Chat" sidebar entry before a prompt is sent. */
export const PENDING_CHAT_ID = '__pending_new_chat__';

/**
 * Manages chat list state for the sidebar and caches chat payloads
 * and content events so the renderer can be rehydrated after reload.
 */
export class ChatState {
    private entries = new Map<string, ChatEntry>();
    private payloads = new Map<string, ChatOpenedParams>();
    private contentEvents = new Map<string, ChatContentReceivedParams[]>();
    private subagentChatIds = new Set<string>();
    private _selectedChatId: string | null = null;
    private workspaceFolderName: string;

    constructor(workspaceFolders: WorkspaceFolder[]) {
        const path = require('path') as typeof import('path');
        this.workspaceFolderName = workspaceFolders[0]?.name || path.basename(process.cwd());
    }

    get selectedChatId(): string | null {
        return this._selectedChatId;
    }

    set selectedChatId(id: string | null) {
        this._selectedChatId = id;
    }

    // ── Subagent tracking ──

    /** Mark a chat as belonging to a subagent so it never appears in the sidebar. */
    markAsSubagent(chatId: string): void {
        this.subagentChatIds.add(chatId);
    }

    /** Returns true if this chat belongs to a subagent. */
    isSubagent(chatId: string): boolean {
        return this.subagentChatIds.has(chatId);
    }

    // ── Entry management ──

    addOrUpdateEntry(chatId: string, partial: Partial<ChatEntry>): void {
        const existing = this.entries.get(chatId);
        this.entries.set(chatId, {
            id: chatId,
            title: partial.title ?? existing?.title ?? 'New Chat',
            status: partial.status ?? existing?.status ?? 'idle',
            workspaceFolderName: partial.workspaceFolderName ?? this.workspaceFolderName,
        });
    }

    /**
     * Populate the sidebar with chat summaries returned by `chat/list`.
     *
     * Intended for app start-up: server-known chats appear in the sidebar
     * immediately, without their message history. The payloads/contentEvents
     * caches are intentionally left untouched — selecting one of these
     * "cold" entries should trigger a `chat/open` so the server streams the
     * content via the normal notification channels.
     *
     * Existing entries for the same chatId keep any richer state they already
     * have (e.g. a `generating` status from a live stream): we only fill in
     * fields that are currently missing.
     */
    addServerKnownEntries(summaries: ChatSummary[]): void {
        for (const summary of summaries) {
            if (this.subagentChatIds.has(summary.id)) continue;
            const existing = this.entries.get(summary.id);
            // If there's already a richer entry (e.g. live generating chat),
            // keep its status/title unless we have nothing yet.
            this.entries.set(summary.id, {
                id: summary.id,
                title: existing?.title ?? summary.title ?? 'New Chat',
                status: existing?.status ?? summary.status ?? 'idle',
                workspaceFolderName: existing?.workspaceFolderName ?? this.workspaceFolderName,
            });
        }
    }

    /**
     * Whether this chat has been "opened" in the current client run — i.e. we
     * have a cached `chat/opened` payload so its content events should already
     * be in memory (or will arrive as the stream progresses). Used to decide
     * whether a sidebar click needs to trigger `chat/open` on the server to
     * hydrate the chat's content.
     */
    hasBeenOpened(chatId: string): boolean {
        return this.payloads.has(chatId);
    }

    updateStatus(chatId: string, status: string): void {
        const entry = this.entries.get(chatId);
        if (entry) {
            entry.status = status;
        }
    }

    removeEntry(chatId: string): void {
        this.entries.delete(chatId);
        this.payloads.delete(chatId);
        this.contentEvents.delete(chatId);
        if (this._selectedChatId === chatId) {
            this._selectedChatId = null;
        }
    }

    // ── Pending "New Chat" placeholder ──

    /** Add a placeholder entry that appears in the sidebar as "New Chat" and select it. */
    addPendingNewChat(): void {
        this.entries.set(PENDING_CHAT_ID, {
            id: PENDING_CHAT_ID,
            title: 'New Chat',
            status: 'idle',
            workspaceFolderName: this.workspaceFolderName,
        });
        this._selectedChatId = PENDING_CHAT_ID;
    }

    /** Remove the pending placeholder. Returns true if one was present. */
    removePendingChat(): boolean {
        const had = this.entries.has(PENDING_CHAT_ID);
        if (had) {
            this.entries.delete(PENDING_CHAT_ID);
            if (this._selectedChatId === PENDING_CHAT_ID) {
                this._selectedChatId = null;
            }
        }
        return had;
    }

    hasPendingChat(): boolean {
        return this.entries.has(PENDING_CHAT_ID);
    }

    // ── Payload cache (for rehydration) ──

    cachePayload(chatId: string, payload: ChatOpenedParams): void {
        this.payloads.set(chatId, payload);
    }

    // ── Content event cache (for rehydration) ──

    pushContentEvent(chatId: string, event: ChatContentReceivedParams): void {
        const events = this.contentEvents.get(chatId) || [];
        events.push(event);
        this.contentEvents.set(chatId, events);
    }

    clearContentEvents(chatId: string): void {
        this.contentEvents.delete(chatId);
    }

    // ── Sidebar list data ──

    getChatListUpdate() {
        return {
            entries: Array.from(this.entries.values()).reverse(),
            selectedId: this._selectedChatId,
            activeWorkspaceFolderName: this.workspaceFolderName,
        };
    }

    // ── Rehydration ──

    /**
     * Replays cached state into the renderer after a reload.
     * Sends chat/opened for each cached payload, then batch-replays content events.
     */
    rehydrate(sendToRenderer: (type: string, data: unknown) => void, workspaceFolders: WorkspaceFolder[]): void {
        // Re-send workspace folders
        sendToRenderer('server/setWorkspaceFolders', workspaceFolders);

        // Re-open each chat shell
        for (const [, payload] of this.payloads) {
            sendToRenderer('chat/opened', payload);
        }

        // Batch-replay content events
        for (const [, events] of this.contentEvents) {
            if (events.length > 0) {
                sendToRenderer('chat/batchContentReceived', events);
            }
        }

        // Restore selection
        if (this._selectedChatId && this.payloads.has(this._selectedChatId)) {
            sendToRenderer('chat/selectChat', this._selectedChatId);
        }
    }
}
