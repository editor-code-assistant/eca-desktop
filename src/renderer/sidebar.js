/**
 * ECA Desktop — Sidebar (vanilla JS)
 *
 * Renders the chat list, handles selection/creation/deletion,
 * and supports mobile drawer toggle.
 */
(function () {
    'use strict';

    var sidebar = document.getElementById('sidebar');
    var chatList = document.getElementById('sidebar-chat-list');
    var newChatBtn = document.getElementById('sidebar-new-chat');
    var overlay = document.getElementById('sidebar-overlay');

    var entries = [];
    var selectedId = null;
    var activeWorkspaceFolderName = null;
    var isOpen = false;

    // ── Helpers ──

    function groupEntriesByWorkspace(entries) {
        var groups = {};
        var groupOrder = [];
        entries.forEach(function (entry) {
            var wsName = entry.workspaceFolderName || 'Default';
            if (!groups[wsName]) {
                groups[wsName] = [];
                groupOrder.push(wsName);
            }
            groups[wsName].push(entry);
        });
        return { groups: groups, groupOrder: groupOrder };
    }

    function createChatItem(entry) {
        var item = document.createElement('div');
        item.className = 'sidebar-chat-item';
        if (entry.id === selectedId) item.classList.add('active');
        if (entry.status === 'generating' || entry.status === 'busy') {
            item.classList.add('generating');
        }

        var title = document.createElement('span');
        title.className = 'sidebar-chat-title';
        title.textContent = entry.title || 'New Chat';

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'sidebar-chat-delete';
        deleteBtn.title = 'Delete chat';
        deleteBtn.textContent = '\u00d7'; // ×
        deleteBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (window.ecaDesktop) {
                window.ecaDesktop.deleteChat(entry.id);
            }
        });

        item.appendChild(title);
        item.appendChild(deleteBtn);

        item.addEventListener('click', function () {
            if (window.ecaDesktop) {
                window.ecaDesktop.selectChat(entry.id);
            }
        });

        return item;
    }

    // ── Render ──

    function render() {
        if (entries.length === 0) {
            chatList.innerHTML =
                '<div class="sidebar-empty">No chats yet.<br>Start a conversation!</div>';
            return;
        }

        chatList.innerHTML = '';

        var result = groupEntriesByWorkspace(entries);

        result.groupOrder.forEach(function (wsName) {
            var group = document.createElement('div');
            group.className = 'sidebar-workspace-group';
            if (wsName === activeWorkspaceFolderName) {
                group.classList.add('active');
            }

            // Workspace header
            var header = document.createElement('div');
            header.className = 'sidebar-workspace-header';

            var indicator = document.createElement('span');
            indicator.className = 'sidebar-workspace-indicator';

            var name = document.createElement('span');
            name.className = 'sidebar-workspace-name';
            name.textContent = wsName;

            header.appendChild(indicator);
            header.appendChild(name);
            group.appendChild(header);

            // Chat items under this workspace
            result.groups[wsName].forEach(function (entry) {
                group.appendChild(createChatItem(entry));
            });

            chatList.appendChild(group);
        });
    }

    // ── Mobile drawer ──

    function closeSidebar() {
        isOpen = false;
        sidebar.classList.remove('open');
        overlay.classList.remove('visible');
    }

    function toggleSidebar() {
        isOpen = !isOpen;
        if (isOpen) {
            sidebar.classList.add('open');
            overlay.classList.add('visible');
        } else {
            closeSidebar();
        }
    }

    // ── Event handlers ──

    newChatBtn.addEventListener('click', function () {
        if (window.ecaDesktop) {
            window.ecaDesktop.newChat();
        }
        closeSidebar();
    });

    overlay.addEventListener('click', closeSidebar);

    // ── IPC listeners ──

    if (window.ecaDesktop) {
        window.ecaDesktop.onChatListUpdate(function (data) {
            entries = data.entries || [];
            selectedId = data.selectedId;
            activeWorkspaceFolderName = data.activeWorkspaceFolderName || null;
            render();
        });

        window.ecaDesktop.onSidebarToggle(function () {
            toggleSidebar();
        });
    }

    // Initial empty render
    render();
})();
