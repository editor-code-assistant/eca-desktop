"use strict";
(() => {
  // src/renderer/theme-bootstrap.ts
  var VALID_THEMES = ["light", "dark"];
  var THEME_CACHE_KEY = "eca-desktop-theme-cache";
  var DEFAULT_THEME = "dark";
  function resolveTheme(value) {
    return typeof value === "string" && VALID_THEMES.includes(value) ? value : DEFAULT_THEME;
  }
  function readCachedTheme() {
    try {
      return resolveTheme(localStorage.getItem(THEME_CACHE_KEY));
    } catch {
      return DEFAULT_THEME;
    }
  }
  function writeCachedTheme(theme) {
    try {
      localStorage.setItem(THEME_CACHE_KEY, theme);
    } catch {
    }
  }
  function applyTheme(theme) {
    const html = document.documentElement;
    if (html.getAttribute("data-editor") !== "web") {
      html.setAttribute("data-editor", "web");
    }
    html.setAttribute("data-theme", theme);
    writeCachedTheme(theme);
  }
  function initThemeBootstrap() {
    const holder = window;
    if (holder.__ecaThemeBootstrapInitialized) return;
    holder.__ecaThemeBootstrapInitialized = true;
    applyTheme(readCachedTheme());
    const api = window.ecaDesktop;
    if (!api || typeof api.getPreferences !== "function") {
      return;
    }
    api.getPreferences().then((prefs) => applyTheme(resolveTheme(prefs?.theme))).catch((err) => {
      console.error("[ThemeBootstrap] Failed to load preferences:", err);
    });
    if (typeof api.onPreferencesUpdated === "function") {
      api.onPreferencesUpdated((prefs) => {
        applyTheme(resolveTheme(prefs?.theme));
      });
    }
  }

  // src/renderer/preferences.ts
  initThemeBootstrap();
  var CATEGORIES = [
    {
      id: "general",
      label: "General",
      iconSvg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    },
    {
      id: "server",
      label: "Server",
      iconSvg: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/>'
    }
  ];
  (function() {
    "use strict";
    const api = window.ecaDesktop;
    if (!api) {
      console.error("[Preferences] ecaDesktop bridge is not available");
      return;
    }
    const root = document.getElementById("prefs-root");
    let activeCategoryId = CATEGORIES[0].id;
    let current = { schemaVersion: 1 };
    const nav = document.createElement("nav");
    nav.className = "prefs-nav";
    const pane = document.createElement("section");
    pane.className = "prefs-pane";
    root.appendChild(nav);
    root.appendChild(pane);
    function renderNav() {
      nav.innerHTML = "";
      for (const cat of CATEGORIES) {
        const item = document.createElement("div");
        item.className = "prefs-nav-item" + (cat.id === activeCategoryId ? " active" : "");
        item.innerHTML = `<svg class="prefs-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${cat.iconSvg}</svg><span>${cat.label}</span>`;
        item.addEventListener("click", () => {
          activeCategoryId = cat.id;
          renderNav();
          renderPane();
        });
        nav.appendChild(item);
      }
    }
    function sectionWrapper(title, description) {
      const section = document.createElement("div");
      section.className = "prefs-section";
      const h = document.createElement("h1");
      h.className = "prefs-section-title";
      h.textContent = title;
      section.appendChild(h);
      if (description) {
        const p = document.createElement("p");
        p.className = "prefs-section-description";
        p.textContent = description;
        section.appendChild(p);
      }
      return section;
    }
    function renderGeneral() {
      const section = sectionWrapper(
        "General",
        "Application-wide preferences."
      );
      section.appendChild(renderThemeField());
      return section;
    }
    function renderThemeField() {
      const field = document.createElement("div");
      field.className = "prefs-field";
      const label = document.createElement("label");
      label.className = "prefs-field-label";
      label.htmlFor = "prefs-theme-select";
      label.textContent = "Theme";
      field.appendChild(label);
      const row = document.createElement("div");
      row.className = "prefs-input-row";
      const select = document.createElement("select");
      select.id = "prefs-theme-select";
      select.className = "prefs-input prefs-select";
      const options = [
        { value: "dark", label: "Dark" },
        { value: "light", label: "Light" }
      ];
      for (const opt of options) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
      }
      select.value = current.theme ?? "dark";
      const message = document.createElement("div");
      message.className = "prefs-message";
      function clearMessage() {
        message.textContent = "";
        message.classList.remove("error", "success");
      }
      function showError(msg) {
        message.textContent = msg;
        message.classList.remove("success");
        message.classList.add("error");
      }
      select.addEventListener("change", async () => {
        clearMessage();
        const nextTheme = select.value === "light" ? "light" : "dark";
        try {
          const result = await api.setPreferences({ theme: nextTheme });
          if (result.ok) {
            current = result.preferences ?? current;
          } else {
            showError(result.error ?? "Could not save theme.");
            select.value = current.theme ?? "dark";
          }
        } catch (err) {
          showError(err?.message ?? "Unexpected error while saving.");
          select.value = current.theme ?? "dark";
        }
      });
      row.appendChild(select);
      field.appendChild(row);
      const hint = document.createElement("div");
      hint.className = "prefs-field-hint";
      hint.textContent = "Controls the appearance of the sidebar, welcome screen, preferences, and chat.";
      field.appendChild(hint);
      field.appendChild(message);
      return field;
    }
    function renderServer() {
      const section = sectionWrapper(
        "Server",
        "Control how the ECA server binary is resolved. When no custom path is set, the latest release is downloaded and managed automatically."
      );
      const field = document.createElement("div");
      field.className = "prefs-field";
      const label = document.createElement("label");
      label.className = "prefs-field-label";
      label.htmlFor = "server-binary-path";
      label.textContent = "Custom server binary path";
      field.appendChild(label);
      const row = document.createElement("div");
      row.className = "prefs-input-row";
      const input = document.createElement("input");
      input.id = "server-binary-path";
      input.className = "prefs-input";
      input.type = "text";
      input.spellcheck = false;
      input.placeholder = "Leave empty to auto-download (recommended)";
      input.value = current.serverBinaryPath ?? "";
      input.addEventListener("input", clearMessages);
      row.appendChild(input);
      const browseBtn = document.createElement("button");
      browseBtn.type = "button";
      browseBtn.className = "prefs-btn prefs-btn-secondary";
      browseBtn.textContent = "Browse\u2026";
      browseBtn.addEventListener("click", async () => {
        const selected = await api.pickServerBinary();
        if (selected) {
          input.value = selected;
          clearMessages();
        }
      });
      row.appendChild(browseBtn);
      field.appendChild(row);
      const hint = document.createElement("div");
      hint.className = "prefs-field-hint";
      hint.textContent = "Absolute path to an eca executable. When set, automatic download and version checks are skipped. Changes apply the next time an ECA server starts.";
      field.appendChild(hint);
      const message = document.createElement("div");
      message.className = "prefs-message";
      field.appendChild(message);
      section.appendChild(field);
      const footer = document.createElement("div");
      footer.className = "prefs-footer";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "prefs-btn prefs-btn-secondary";
      clearBtn.textContent = "Use default (auto-download)";
      clearBtn.addEventListener("click", async () => {
        input.value = "";
        await save("");
      });
      footer.appendChild(clearBtn);
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "prefs-btn prefs-btn-primary";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async () => {
        await save(input.value);
      });
      footer.appendChild(saveBtn);
      section.appendChild(footer);
      function clearMessages() {
        message.textContent = "";
        message.classList.remove("error", "success");
        input.classList.remove("invalid");
      }
      function showError(msg) {
        message.textContent = msg;
        message.classList.remove("success");
        message.classList.add("error");
        input.classList.add("invalid");
      }
      function showSuccess(msg) {
        message.textContent = msg;
        message.classList.remove("error");
        message.classList.add("success");
        input.classList.remove("invalid");
      }
      async function save(value) {
        clearMessages();
        const trimmed = value.trim();
        const patch = {
          serverBinaryPath: trimmed === "" ? void 0 : trimmed
        };
        try {
          const result = await api.setPreferences(patch);
          if (result.ok) {
            current = result.preferences ?? current;
            showSuccess(
              trimmed ? "Saved. New binary will be used on next server start." : "Cleared. Auto-download will resume on next server start."
            );
          } else {
            showError(result.error ?? "Could not save preferences.");
          }
        } catch (err) {
          showError(err?.message ?? "Unexpected error while saving.");
        }
      }
      return section;
    }
    function renderPane() {
      pane.innerHTML = "";
      switch (activeCategoryId) {
        case "server":
          pane.appendChild(renderServer());
          break;
        case "general":
        default:
          pane.appendChild(renderGeneral());
          break;
      }
    }
    api.getPreferences().then((prefs) => {
      current = prefs;
      renderNav();
      renderPane();
    }).catch((err) => {
      console.error("[Preferences] Failed to load:", err);
      renderNav();
      renderPane();
    });
    api.onPreferencesUpdated((prefs) => {
      current = prefs;
      renderPane();
    });
  })();
})();
