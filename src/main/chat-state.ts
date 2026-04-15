// ============================================================
// Chat state management — sidebar entries + rehydration cache
// ============================================================

import { BrowserWindow } from 'electron';
import { ChatEntry, ChatOpenedParams, ChatContentReceivedParams, WorkspaceFolder } from './protocol';

/**
 * Manages chat list state for the sidebar and caches chat payloads
 * and content events so the renderer can be rehydrated after reload.
 */
export class ChatState {
    private entries = new Map<string, ChatEntry>();
    private payloads = new Map<string, ChatOpenedParams>();
    private contentEvents = new Map<string, ChatContentReceivedParams[]>();
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
