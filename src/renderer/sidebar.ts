/**
 * ECA Desktop — Sidebar
 *
 * Renders the chat list, handles selection/creation/deletion,
 * and supports mobile drawer toggle.
 */

// Make this file a module so `declare global` works
export {};

import { initThemeBootstrap } from './theme-bootstrap';

// Apply the persisted theme to the main window before we render any
// sidebar chrome so the first paint is correct.
initThemeBootstrap();

// ── Type declarations for the preload API ──

interface ChatEntry {
    id: string;
    title: string;
    status: string;
    workspaceFolderName: string;
    /** Epoch millis when the chat was last touched. */
    updatedAt?: number;
}

interface ChatListUpdate {
    entries: ChatEntry[];
    selectedId: string | null;
    activeWorkspaceFolderName: string | null;
}

interface SessionInfo {
    id: string;
    workspaceFolder: { name: string; uri: string };
    status: string;
}

interface SessionListUpdate {
    sessions: SessionInfo[];
    activeSessionId: string | null;
}

interface EcaDesktopApi {
    send: (message: unknown) => void;
    onMessage: (callback: (message: unknown) => void) => void;
    removeMessageListener: (callback: (message: unknown) => void) => void;
    platform: string;
    onChatListUpdate: (callback: (data: ChatListUpdate) => void) => void;
    removeChatListListener: (callback: (data: ChatListUpdate) => void) => void;
    onSidebarToggle: (callback: () => void) => void;
    removeSidebarToggleListener: (callback: () => void) => void;
    selectChat: (chatId: string) => void;
    newChat: (sessionId?: string) => void;
    deleteChat: (chatId: string) => void;
    createSession: (uri?: string) => void;
    removeSession: (sessionId: string) => void;
    onSessionListUpdate: (callback: (data: SessionListUpdate) => void) => void;
}

declare global {
    interface Window {
        ecaDesktop?: EcaDesktopApi;
    }
}

(function () {
    'use strict';

    const sidebar = document.getElementById('sidebar')!;
    const chatList = document.getElementById('sidebar-chat-list')!;
    const newChatBtn = document.getElementById('sidebar-new-chat')!;
    const overlay = document.getElementById('sidebar-overlay')!;

    let entries: ChatEntry[] = [];
    let selectedId: string | null = null;
    let activeWorkspaceFolderName: string | null = null;
    let sessions: SessionInfo[] = [];
    let activeSessionId: string | null = null;
    let isOpen = false;

    // ── Show-more / collapse state ──
    //
    // Each workspace group renders at most MAX_CHATS_COLLAPSED chats by default
    // with a "Show N more" affordance underneath. We track the user's choice
    // per workspace *name* rather than per session id, because session ids are
    // regenerated on every app launch while workspace folder names are stable.
    // Persisted to localStorage so the state survives dev reloads & restarts.
    const MAX_CHATS_COLLAPSED = 7;
    const EXPANDED_STORAGE_KEY = 'eca-sidebar-expanded-workspaces';

    function loadExpandedWorkspaces(): Set<string> {
        try {
            const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
            if (!raw) return new Set();
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(parsed.filter((v): v is string => typeof v === 'string'));
            }
        } catch {
            // Corrupted value — ignore and start fresh.
        }
        return new Set();
    }

    function saveExpandedWorkspaces(): void {
        try {
            localStorage.setItem(
                EXPANDED_STORAGE_KEY,
                JSON.stringify(Array.from(expandedWorkspaces)),
            );
        } catch {
            // Storage may be unavailable (privacy mode etc.) — in-memory state
            // still works for the current session.
        }
    }

    const expandedWorkspaces: Set<string> = loadExpandedWorkspaces();

    // ── Helpers ──

    function groupEntriesByWorkspace(items: ChatEntry[]): {
        groups: Record<string, ChatEntry[]>;
        groupOrder: string[];
    } {
        const groups: Record<string, ChatEntry[]> = {};
        const groupOrder: string[] = [];
        items.forEach((entry) => {
            const wsName = entry.workspaceFolderName || 'Default';
            if (!groups[wsName]) {
                groups[wsName] = [];
                groupOrder.push(wsName);
            }
            groups[wsName].push(entry);
        });
        return { groups, groupOrder };
    }

    /**
     * Concise relative-date label for a sidebar chat entry. Matches the
     * familiar Slack/iMessage style so the column stays narrow:
     *   < 1 min        -> "now"
     *   < 1 hour       -> "5m"
     *   < 24 hours     -> "3h"
     *   < 7 days       -> "2d"
     *   same calendar year -> "Dec 5"
     *   older          -> "Dec 2024"
     */
    function formatRelativeDate(ms: number): string {
        const now = Date.now();
        const diffMs = now - ms;
        // Clock skew — treat future timestamps as "now" rather than negative.
        if (diffMs < 60_000) return 'now';
        if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
        if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
        if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d`;

        const date = new Date(ms);
        const nowDate = new Date(now);
        const month = date.toLocaleString('en-US', { month: 'short' });
        if (date.getFullYear() === nowDate.getFullYear()) {
            return `${month} ${date.getDate()}`;
        }
        return `${month} ${date.getFullYear()}`;
    }

    /**
     * Build a "Show N more" / "Show less" row for a workspace group. The
     * caller is responsible for appending it under the sliced chat list;
     * clicking it toggles the workspace's expanded state and re-renders.
     */
    function createShowMoreToggle(
        workspaceName: string,
        hiddenCount: number,
        expanded: boolean,
    ): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'sidebar-show-more';
        row.textContent = expanded ? 'Show less' : `Show ${hiddenCount} more`;
        row.title = expanded
            ? 'Collapse to the most recent chats'
            : `Show all chats for ${workspaceName}`;
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (expanded) {
                expandedWorkspaces.delete(workspaceName);
            } else {
                expandedWorkspaces.add(workspaceName);
            }
            saveExpandedWorkspaces();
            render();
        });
        return row;
    }

    function createChatItem(entry: ChatEntry): HTMLDivElement {
        const item = document.createElement('div');
        item.className = 'sidebar-chat-item';
        if (entry.id === selectedId) item.classList.add('active');
        // Mutually exclusive visual states (only one color wins):
        //   - waiting-approval (orange) beats generating because an approval
        //     request is the more actionable, attention-grabbing state.
        //   - generating/running/busy (soft gold) is the default in-flight
        //     indicator. The set of accepted strings reflects all sources:
        //     'generating' is set optimistically by the router when a brand-
        //     new chat is created, while 'running' is what the ECA server
        //     emits via chat/statusChanged for every in-flight prompt
        //     (including follow-ups). 'busy' is kept for legacy/back-compat.
        const isWaitingApproval = entry.status === 'waiting-approval';
        const isActive = !isWaitingApproval && (
            entry.status === 'generating' ||
            entry.status === 'running' ||
            entry.status === 'busy'
        );
        if (isWaitingApproval) item.classList.add('waiting-approval');
        else if (isActive) item.classList.add('generating');

        // Status dot — visible when generating or waiting for approval
        const dot = document.createElement('span');
        dot.className = 'sidebar-chat-dot';

        const title = document.createElement('span');
        title.className = 'sidebar-chat-title';
        title.textContent = entry.title || 'New Chat';

        // Concise relative-date label (e.g. "3h", "Dec 5"). Only rendered
        // when we have a timestamp to avoid a misleading "now" for entries
        // that predate the updatedAt plumbing.
        let dateEl: HTMLSpanElement | null = null;
        if (typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)) {
            dateEl = document.createElement('span');
            dateEl.className = 'sidebar-chat-date';
            dateEl.textContent = formatRelativeDate(entry.updatedAt);
            dateEl.title = new Date(entry.updatedAt).toLocaleString();
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'sidebar-chat-delete';
        deleteBtn.title = 'Delete chat';
        deleteBtn.textContent = '\u00d7'; // ×
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.ecaDesktop?.deleteChat(entry.id);
        });

        item.appendChild(dot);
        item.appendChild(title);
        if (dateEl) item.appendChild(dateEl);
        item.appendChild(deleteBtn);

        item.addEventListener('click', () => {
            window.ecaDesktop?.selectChat(entry.id);
        });

        return item;
    }

    // ── Render ──

    function render(): void {
        newChatBtn.style.display = sessions.length > 0 ? '' : 'none';
        chatList.innerHTML = '';

        if (sessions.length === 0 && entries.length === 0) {
            chatList.innerHTML =
                '<div class="sidebar-empty">No sessions yet.<br>Open a folder to start!</div>';
            return;
        }

        // If we have sessions, render workspace groups from sessions
        if (sessions.length > 0) {
            sessions.forEach((session) => {
                const group = document.createElement('div');
                group.className = 'sidebar-workspace-group';
                if (session.id === activeSessionId) {
                    group.classList.add('active');
                }

                // Workspace header
                const header = document.createElement('div');
                header.className = 'sidebar-workspace-header';

                const indicator = document.createElement('span');
                indicator.className = 'sidebar-workspace-indicator';
                indicator.classList.add('status-' + session.status.toLowerCase());

                const name = document.createElement('span');
                name.className = 'sidebar-workspace-name';
                name.textContent = session.workspaceFolder.name;
                name.title = session.workspaceFolder.uri;

                const actions = document.createElement('div');
                actions.className = 'sidebar-workspace-actions';

                const newChatInSession = document.createElement('button');
                newChatInSession.className = 'sidebar-workspace-action-btn';
                newChatInSession.title = 'New Chat';
                newChatInSession.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
                newChatInSession.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.ecaDesktop?.newChat(session.id);
                    closeSidebar();
                });

                const closeBtn = document.createElement('button');
                closeBtn.className = 'sidebar-workspace-action-btn sidebar-workspace-close';
                closeBtn.title = 'Close session';
                closeBtn.textContent = '\u00d7'; // ×
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    window.ecaDesktop?.removeSession(session.id);
                });

                actions.appendChild(newChatInSession);
                actions.appendChild(closeBtn);

                header.appendChild(indicator);
                header.appendChild(name);
                header.appendChild(actions);
                group.appendChild(header);

                // Filter entries for this session's workspace
                const sessionEntries = entries.filter(
                    (e) => e.workspaceFolderName === session.workspaceFolder.name
                );

                const wsName = session.workspaceFolder.name;
                const expanded = expandedWorkspaces.has(wsName);
                const visibleEntries =
                    sessionEntries.length > MAX_CHATS_COLLAPSED && !expanded
                        ? sessionEntries.slice(0, MAX_CHATS_COLLAPSED)
                        : sessionEntries;

                visibleEntries.forEach((entry) => {
                    group.appendChild(createChatItem(entry));
                });

                if (sessionEntries.length > MAX_CHATS_COLLAPSED) {
                    const hiddenCount = sessionEntries.length - visibleEntries.length;
                    group.appendChild(
                        createShowMoreToggle(wsName, hiddenCount, expanded),
                    );
                }

                // If no chats yet, show hint
                if (sessionEntries.length === 0) {
                    const hint = document.createElement('div');
                    hint.className = 'sidebar-session-hint';
                    hint.textContent = 'No chats yet';
                    group.appendChild(hint);
                }

                chatList.appendChild(group);
            });
        } else {
            // Fallback: just show entries grouped by workspace (old behavior)
            const result = groupEntriesByWorkspace(entries);
            result.groupOrder.forEach((wsName) => {
                const group = document.createElement('div');
                group.className = 'sidebar-workspace-group';
                if (wsName === activeWorkspaceFolderName) group.classList.add('active');

                const header = document.createElement('div');
                header.className = 'sidebar-workspace-header';
                const indicator = document.createElement('span');
                indicator.className = 'sidebar-workspace-indicator';
                const nameEl = document.createElement('span');
                nameEl.className = 'sidebar-workspace-name';
                nameEl.textContent = wsName;
                header.appendChild(indicator);
                header.appendChild(nameEl);
                group.appendChild(header);

                const wsEntries = result.groups[wsName];
                const expanded = expandedWorkspaces.has(wsName);
                const visibleEntries =
                    wsEntries.length > MAX_CHATS_COLLAPSED && !expanded
                        ? wsEntries.slice(0, MAX_CHATS_COLLAPSED)
                        : wsEntries;

                visibleEntries.forEach((entry) => {
                    group.appendChild(createChatItem(entry));
                });

                if (wsEntries.length > MAX_CHATS_COLLAPSED) {
                    const hiddenCount = wsEntries.length - visibleEntries.length;
                    group.appendChild(
                        createShowMoreToggle(wsName, hiddenCount, expanded),
                    );
                }

                chatList.appendChild(group);
            });
        }
    }

    // ── Mobile drawer ──

    function closeSidebar(): void {
        isOpen = false;
        sidebar.classList.remove('open');
        overlay.classList.remove('visible');
    }

    function toggleSidebar(): void {
        isOpen = !isOpen;
        if (isOpen) {
            sidebar.classList.add('open');
            overlay.classList.add('visible');
        } else {
            closeSidebar();
        }
    }

    // ── Event handlers ──

    newChatBtn.addEventListener('click', () => {
        window.ecaDesktop?.newChat();
        closeSidebar();
    });

    const openFolderBtn = document.getElementById('sidebar-open-folder');
    if (openFolderBtn) {
        openFolderBtn.addEventListener('click', () => {
            window.ecaDesktop?.createSession();
        });
    }

    overlay.addEventListener('click', closeSidebar);

    // ── IPC listeners ──

    if (window.ecaDesktop) {
        window.ecaDesktop.onChatListUpdate((data: ChatListUpdate) => {
            entries = data.entries || [];
            selectedId = data.selectedId;
            activeWorkspaceFolderName = data.activeWorkspaceFolderName || null;
            render();
        });

        window.ecaDesktop.onSidebarToggle(() => {
            toggleSidebar();
        });

        window.ecaDesktop.onSessionListUpdate((data: SessionListUpdate) => {
            sessions = data.sessions || [];
            activeSessionId = data.activeSessionId;
            render();
        });
    }

    // Initial empty render
    render();
})();
