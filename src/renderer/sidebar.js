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
    let sessions = [];
    let activeSessionId = null;
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
      newChatBtn.style.display = sessions.length > 0 ? "" : "none";
      chatList.innerHTML = "";
      if (sessions.length === 0 && entries.length === 0) {
        chatList.innerHTML = '<div class="sidebar-empty">No sessions yet.<br>Open a folder to start!</div>';
        return;
      }
      if (sessions.length > 0) {
        sessions.forEach((session) => {
          const group = document.createElement("div");
          group.className = "sidebar-workspace-group";
          if (session.id === activeSessionId) {
            group.classList.add("active");
          }
          const header = document.createElement("div");
          header.className = "sidebar-workspace-header";
          const indicator = document.createElement("span");
          indicator.className = "sidebar-workspace-indicator";
          indicator.classList.add("status-" + session.status.toLowerCase());
          const name = document.createElement("span");
          name.className = "sidebar-workspace-name";
          name.textContent = session.workspaceFolder.name;
          name.title = session.workspaceFolder.uri;
          const actions = document.createElement("div");
          actions.className = "sidebar-workspace-actions";
          const newChatInSession = document.createElement("button");
          newChatInSession.className = "sidebar-workspace-action-btn";
          newChatInSession.title = "New Chat";
          newChatInSession.innerHTML = '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
          newChatInSession.addEventListener("click", (e) => {
            e.stopPropagation();
            window.ecaDesktop?.newChat();
          });
          const closeBtn = document.createElement("button");
          closeBtn.className = "sidebar-workspace-action-btn sidebar-workspace-close";
          closeBtn.title = "Close session";
          closeBtn.textContent = "\xD7";
          closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            window.ecaDesktop?.removeSession(session.id);
          });
          actions.appendChild(newChatInSession);
          actions.appendChild(closeBtn);
          header.appendChild(indicator);
          header.appendChild(name);
          header.appendChild(actions);
          group.appendChild(header);
          const sessionEntries = entries.filter(
            (e) => e.workspaceFolderName === session.workspaceFolder.name
          );
          sessionEntries.forEach((entry) => {
            group.appendChild(createChatItem(entry));
          });
          if (sessionEntries.length === 0) {
            const hint = document.createElement("div");
            hint.className = "sidebar-session-hint";
            hint.textContent = "No chats yet";
            group.appendChild(hint);
          }
          chatList.appendChild(group);
        });
      } else {
        const result = groupEntriesByWorkspace(entries);
        result.groupOrder.forEach((wsName) => {
          const group = document.createElement("div");
          group.className = "sidebar-workspace-group";
          if (wsName === activeWorkspaceFolderName) group.classList.add("active");
          const header = document.createElement("div");
          header.className = "sidebar-workspace-header";
          const indicator = document.createElement("span");
          indicator.className = "sidebar-workspace-indicator";
          const nameEl = document.createElement("span");
          nameEl.className = "sidebar-workspace-name";
          nameEl.textContent = wsName;
          header.appendChild(indicator);
          header.appendChild(nameEl);
          group.appendChild(header);
          result.groups[wsName].forEach((entry) => {
            group.appendChild(createChatItem(entry));
          });
          chatList.appendChild(group);
        });
      }
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
    const openFolderBtn = document.getElementById("sidebar-open-folder");
    if (openFolderBtn) {
      openFolderBtn.addEventListener("click", () => {
        window.ecaDesktop?.createSession();
      });
    }
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
      window.ecaDesktop.onSessionListUpdate((data) => {
        sessions = data.sessions || [];
        activeSessionId = data.activeSessionId;
        render();
      });
    }
    render();
  })();
})();
