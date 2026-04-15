/**
 * ECA Desktop — Sidebar
 *
 * Renders the chat list, handles selection/creation/deletion,
 * and supports mobile drawer toggle.
 */

// Make this file a module so `declare global` works
export {};

// ── Type declarations for the preload API ──

interface ChatEntry {
    id: string;
    title: string;
    status: string;
    workspaceFolderName: string;
}

interface ChatListUpdate {
    entries: ChatEntry[];
    selectedId: string | null;
    activeWorkspaceFolderName: string | null;
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
    newChat: () => void;
    deleteChat: (chatId: string) => void;
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
    let isOpen = false;

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

    function createChatItem(entry: ChatEntry): HTMLDivElement {
        const item = document.createElement('div');
        item.className = 'sidebar-chat-item';
        if (entry.id === selectedId) item.classList.add('active');
        if (entry.status === 'generating' || entry.status === 'busy') {
            item.classList.add('generating');
        }

        const title = document.createElement('span');
        title.className = 'sidebar-chat-title';
        title.textContent = entry.title || 'New Chat';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'sidebar-chat-delete';
        deleteBtn.title = 'Delete chat';
        deleteBtn.textContent = '\u00d7'; // ×
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.ecaDesktop?.deleteChat(entry.id);
        });

        item.appendChild(title);
        item.appendChild(deleteBtn);

        item.addEventListener('click', () => {
            window.ecaDesktop?.selectChat(entry.id);
        });

        return item;
    }

    // ── Render ──

    function render(): void {
        if (entries.length === 0) {
            chatList.innerHTML =
                '<div class="sidebar-empty">No chats yet.<br>Start a conversation!</div>';
            return;
        }

        chatList.innerHTML = '';

        const result = groupEntriesByWorkspace(entries);

        result.groupOrder.forEach((wsName) => {
            const group = document.createElement('div');
            group.className = 'sidebar-workspace-group';
            if (wsName === activeWorkspaceFolderName) {
                group.classList.add('active');
            }

            // Workspace header
            const header = document.createElement('div');
            header.className = 'sidebar-workspace-header';

            const indicator = document.createElement('span');
            indicator.className = 'sidebar-workspace-indicator';

            const name = document.createElement('span');
            name.className = 'sidebar-workspace-name';
            name.textContent = wsName;

            header.appendChild(indicator);
            header.appendChild(name);
            group.appendChild(header);

            // Chat items under this workspace
            result.groups[wsName].forEach((entry) => {
                group.appendChild(createChatItem(entry));
            });

            chatList.appendChild(group);
        });
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
    }

    // Initial empty render
    render();
})();
