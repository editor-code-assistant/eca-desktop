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
    /**
     * Tool calls awaiting manual user approval, keyed by chatId.
     * Populated from `toolCallRun` content events (with manualApproval=true)
     * and cleared when the tool transitions to running / rejected / called.
     * Drives the sidebar's orange "waiting-approval" badge (see
     * `getChatListUpdate` override + sidebar.css .waiting-approval).
     */
    private pendingApprovals = new Map<string, Set<string>>();
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

    /**
     * Mark a chat as belonging to a subagent so it never appears in the
     * sidebar. Also cleans up any entry that had already been recorded — an
     * entry-creating event (e.g. a metadata content event with a title) can
     * in theory reach us before the chat/opened that tells us it's a
     * subagent.
     */
    markAsSubagent(chatId: string): void {
        this.subagentChatIds.add(chatId);
        if (this.entries.has(chatId)) {
            this.entries.delete(chatId);
        }
        // Subagent chats never surface in the sidebar — drop any pending
        // approvals we may have tracked so the map doesn't leak.
        this.pendingApprovals.delete(chatId);
        if (this._selectedChatId === chatId) {
            this._selectedChatId = null;
        }
    }

    /** Returns true if this chat belongs to a subagent. */
    isSubagent(chatId: string): boolean {
        return this.subagentChatIds.has(chatId);
    }

    // ── Entry management ──

    addOrUpdateEntry(chatId: string, partial: Partial<ChatEntry>): void {
        // Subagent chats never surface in the sidebar — guarding here (rather
        // than at each call site) keeps all entry-creating code paths safe
        // without each caller having to remember the rule.
        if (this.subagentChatIds.has(chatId)) return;

        const existing = this.entries.get(chatId);
        // updatedAt policy:
        // - explicit value from the caller always wins,
        // - otherwise keep whatever was already there,
        // - otherwise (brand-new entry with no server timestamp) default to
        //   "now" so the sidebar can show a sensible date even for chats
        //   created optimistically in the current session.
        const updatedAt =
            partial.updatedAt ?? existing?.updatedAt ?? (existing ? undefined : Date.now());
        this.entries.set(chatId, {
            id: chatId,
            title: partial.title ?? existing?.title ?? 'New Chat',
            status: partial.status ?? existing?.status ?? 'idle',
            workspaceFolderName: partial.workspaceFolderName ?? this.workspaceFolderName,
            ...(updatedAt !== undefined ? { updatedAt } : {}),
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
        // The server returns chats sorted newest-first (desc by updatedAt),
        // but the client's Map-order invariant is "most-recently-touched lives
        // at the end". `getChatListUpdate` then `.reverse()`s so the newest
        // ends up at the top of the sidebar. To preserve that invariant we
        // must insert from oldest to newest, hence the reversed iteration.
        for (let i = summaries.length - 1; i >= 0; i--) {
            const summary = summaries[i];
            if (this.subagentChatIds.has(summary.id)) continue;
            const existing = this.entries.get(summary.id);
            // If there's already a richer entry (e.g. live generating chat),
            // keep its status/title unless we have nothing yet.
            this.entries.set(summary.id, {
                id: summary.id,
                title: existing?.title ?? summary.title ?? 'New Chat',
                status: existing?.status ?? summary.status ?? 'idle',
                workspaceFolderName: existing?.workspaceFolderName ?? this.workspaceFolderName,
                // Prefer the server's updatedAt (authoritative last-touched) so
                // the sidebar can display a correct date even for chats that
                // haven't been opened in this session yet.
                ...(summary.updatedAt !== undefined || existing?.updatedAt !== undefined
                    ? { updatedAt: summary.updatedAt ?? existing?.updatedAt }
                    : {}),
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
        this.pendingApprovals.delete(chatId);
        if (this._selectedChatId === chatId) {
            this._selectedChatId = null;
        }
    }

    // ── Pending tool-call approvals (sidebar "waiting-approval" signal) ──

    /**
     * Record that a specific tool call in this chat is blocked on the user
     * granting manual approval. The sidebar overlay this as a 'waiting-
     * approval' status (orange) in `getChatListUpdate`.
     */
    markToolCallWaitingApproval(chatId: string, toolCallId: string): void {
        if (this.subagentChatIds.has(chatId)) return;
        let ids = this.pendingApprovals.get(chatId);
        if (!ids) {
            ids = new Set<string>();
            this.pendingApprovals.set(chatId, ids);
        }
        ids.add(toolCallId);
    }

    /**
     * Clear a previously-recorded pending approval for this tool call.
     * Called when the tool transitions to running / rejected / called.
     * Deletes the chat's entry from the map once its set empties so
     * `hasPendingApproval` returns false without further checks.
     */
    markToolCallNotWaitingApproval(chatId: string, toolCallId: string): void {
        const ids = this.pendingApprovals.get(chatId);
        if (!ids) return;
        ids.delete(toolCallId);
        if (ids.size === 0) {
            this.pendingApprovals.delete(chatId);
        }
    }

    /** True when the given chat has at least one tool call awaiting approval. */
    hasPendingApproval(chatId: string): boolean {
        const ids = this.pendingApprovals.get(chatId);
        return !!ids && ids.size > 0;
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
        // Overlay the 'waiting-approval' status on entries that have at
        // least one tool call blocked on manual approval. This is computed
        // on read (rather than stored on the entry) so the source of truth
        // stays the pendingApprovals map — the moment the last tool call
        // clears, the sidebar reverts to whatever server status was last
        // broadcast (e.g. 'generating' while the model keeps working).
        const entries = Array.from(this.entries.values())
            .reverse()
            .map(entry =>
                this.hasPendingApproval(entry.id)
                    ? { ...entry, status: 'waiting-approval' }
                    : entry,
            );
        return {
            entries,
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
