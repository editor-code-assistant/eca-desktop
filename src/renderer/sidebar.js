"use strict";
(() => {
  // src/renderer/sidebar.ts
  (function() {
    "use strict";
    const sidebar = document.getElementById("sidebar");
    const chatList = document.getElementById("sidebar-chat-list");
    const newChatBtn = document.getElementById("sidebar-new-chat");
    const overlay = document.getElementById("sidebar-overlay");
    let entries = [];
    let selectedId = null;
    let activeWorkspaceFolderName = null;
    let isOpen = false;
    function groupEntriesByWorkspace(items) {
      const groups = {};
      const groupOrder = [];
      items.forEach((entry) => {
        const wsName = entry.workspaceFolderName || "Default";
        if (!groups[wsName]) {
          groups[wsName] = [];
          groupOrder.push(wsName);
        }
        groups[wsName].push(entry);
      });
      return { groups, groupOrder };
    }
    function createChatItem(entry) {
      const item = document.createElement("div");
      item.className = "sidebar-chat-item";
      if (entry.id === selectedId) item.classList.add("active");
      if (entry.status === "generating" || entry.status === "busy") {
        item.classList.add("generating");
      }
      const title = document.createElement("span");
      title.className = "sidebar-chat-title";
      title.textContent = entry.title || "New Chat";
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "sidebar-chat-delete";
      deleteBtn.title = "Delete chat";
      deleteBtn.textContent = "\xD7";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.ecaDesktop?.deleteChat(entry.id);
      });
      item.appendChild(title);
      item.appendChild(deleteBtn);
      item.addEventListener("click", () => {
        window.ecaDesktop?.selectChat(entry.id);
      });
      return item;
    }
    function render() {
      if (entries.length === 0) {
        chatList.innerHTML = '<div class="sidebar-empty">No chats yet.<br>Start a conversation!</div>';
        return;
      }
      chatList.innerHTML = "";
      const result = groupEntriesByWorkspace(entries);
      result.groupOrder.forEach((wsName) => {
        const group = document.createElement("div");
        group.className = "sidebar-workspace-group";
        if (wsName === activeWorkspaceFolderName) {
          group.classList.add("active");
        }
        const header = document.createElement("div");
        header.className = "sidebar-workspace-header";
        const indicator = document.createElement("span");
        indicator.className = "sidebar-workspace-indicator";
        const name = document.createElement("span");
        name.className = "sidebar-workspace-name";
        name.textContent = wsName;
        header.appendChild(indicator);
        header.appendChild(name);
        group.appendChild(header);
        result.groups[wsName].forEach((entry) => {
          group.appendChild(createChatItem(entry));
        });
        chatList.appendChild(group);
      });
    }
    function closeSidebar() {
      isOpen = false;
      sidebar.classList.remove("open");
      overlay.classList.remove("visible");
    }
    function toggleSidebar() {
      isOpen = !isOpen;
      if (isOpen) {
        sidebar.classList.add("open");
        overlay.classList.add("visible");
      } else {
        closeSidebar();
      }
    }
    newChatBtn.addEventListener("click", () => {
      window.ecaDesktop?.newChat();
      closeSidebar();
    });
    overlay.addEventListener("click", closeSidebar);
    if (window.ecaDesktop) {
      window.ecaDesktop.onChatListUpdate((data) => {
        entries = data.entries || [];
        selectedId = data.selectedId;
        activeWorkspaceFolderName = data.activeWorkspaceFolderName || null;
        render();
      });
      window.ecaDesktop.onSidebarToggle(() => {
        toggleSidebar();
      });
    }
    render();
  })();
})();
