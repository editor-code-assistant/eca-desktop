"use strict";
(() => {
  // src/renderer/welcome.ts
  (function() {
    "use strict";
    const welcomeScreen = document.getElementById("welcome-screen");
    const root = document.getElementById("root");
    let recentWorkspaces = [];
    let hasSessions = false;
    const snippets = [
      "const ",
      "let ",
      "fn ",
      "def ",
      "import ",
      "export ",
      "return ",
      "async ",
      "await ",
      "if ",
      "else ",
      "for ",
      "while ",
      "match ",
      "=> ",
      "-> ",
      ":: ",
      "() ",
      "[] ",
      "{}",
      "..",
      "// ",
      "true",
      "false",
      "null",
      "nil",
      "self",
      "this",
      "pub ",
      "use ",
      "mod ",
      "impl ",
      "trait ",
      "type ",
      "<T>",
      "Ok()",
      "Err",
      "Some",
      "None",
      "println!",
      "console.",
      "print(",
      "log(",
      "= ",
      "!= ",
      "== ",
      ">= ",
      "<= ",
      "&& ",
      "|| ",
      "0x",
      "127",
      "443",
      "8080",
      "3000",
      "utf-8",
      "json",
      "ssh",
      "tcp",
      "http",
      "fn main",
      "class ",
      "struct ",
      "enum ",
      ".map(",
      ".filter(",
      ".then(",
      ".catch(",
      "Result<",
      "Vec<",
      "Option<",
      "Promise<",
      "|> ",
      ":ok",
      ":error",
      "defmodule "
    ];
    const randomSnippet = () => snippets[Math.floor(Math.random() * snippets.length)];
    let rainCanvas = null;
    let rainCtx = null;
    let rainColumns = [];
    let rainAnimId = 0;
    let rainW = 0;
    let rainH = 0;
    function makeColumn(x, randomizeY) {
      return {
        x,
        y: randomizeY ? Math.random() * rainH : -20,
        speed: 0.15 + Math.random() * 0.35,
        opacity: 0.12 + Math.random() * 0.14,
        chars: randomSnippet() + randomSnippet() + " " + randomSnippet(),
        charIndex: 0,
        fontSize: 10 + Math.floor(Math.random() * 3)
      };
    }
    function initRainColumns() {
      const colGap = 28;
      const count = Math.ceil(rainW / colGap);
      rainColumns = Array.from({ length: count }, (_, i) => makeColumn(i * colGap, true));
    }
    function resizeRain() {
      if (!rainCanvas || !rainCtx) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = rainCanvas.getBoundingClientRect();
      rainW = rect.width;
      rainH = rect.height;
      rainCanvas.width = rainW * dpr;
      rainCanvas.height = rainH * dpr;
      rainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initRainColumns();
    }
    function drawRain() {
      if (!rainCtx) return;
      rainCtx.clearRect(0, 0, rainW, rainH);
      const centerX = rainW / 2;
      const centerY = rainH / 2;
      const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);
      for (const col of rainColumns) {
        rainCtx.font = `${col.fontSize}px "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace`;
        const lineH = col.fontSize + 4;
        const visible = col.chars.slice(0, Math.floor(col.charIndex));
        const dx = Math.abs(col.x - centerX) / centerX;
        const centerFade = Math.pow(Math.min(dx * 1.4, 1), 2);
        for (let j = 0; j < visible.length; j++) {
          const distFromHead = visible.length - 1 - j;
          const fade = Math.max(0, 1 - distFromHead * 0.08);
          const charY = col.y + j * lineH;
          const dy = Math.abs(charY - centerY) / centerY;
          const vertFade = Math.pow(Math.min(dy * 1.2, 1), 1.5);
          const spatialFade = Math.max(centerFade, vertFade);
          const alpha = col.opacity * fade * spatialFade;
          if (j === visible.length - 1) {
            rainCtx.fillStyle = `rgba(0, 200, 220, ${Math.min(alpha * 3, 0.6)})`;
          } else {
            rainCtx.fillStyle = `rgba(180, 200, 220, ${alpha})`;
          }
          rainCtx.fillText(visible[j], col.x, col.y + j * lineH);
        }
        col.charIndex += col.speed * 0.5;
        col.y += col.speed;
        if (col.y > rainH + 40) {
          col.y = -(col.chars.length * (col.fontSize + 4));
          col.chars = randomSnippet() + randomSnippet() + " " + randomSnippet();
          col.charIndex = 0;
          col.speed = 0.15 + Math.random() * 0.35;
          col.opacity = 0.06 + Math.random() * 0.09;
        }
        if (col.charIndex > col.chars.length + 6) {
          col.chars = randomSnippet() + randomSnippet() + " " + randomSnippet();
          col.charIndex = 0;
        }
      }
      rainAnimId = requestAnimationFrame(drawRain);
    }
    function startRain() {
      if (rainCanvas) return;
      rainCanvas = document.createElement("canvas");
      rainCanvas.className = "welcome-rain";
      rainCanvas.setAttribute("aria-hidden", "true");
      welcomeScreen.insertBefore(rainCanvas, welcomeScreen.firstChild);
      rainCtx = rainCanvas.getContext("2d");
      if (!rainCtx) return;
      resizeRain();
      rainAnimId = requestAnimationFrame(drawRain);
      window.addEventListener("resize", resizeRain);
    }
    function stopRain() {
      cancelAnimationFrame(rainAnimId);
      window.removeEventListener("resize", resizeRain);
      if (rainCanvas && rainCanvas.parentNode) {
        rainCanvas.parentNode.removeChild(rainCanvas);
      }
      rainCanvas = null;
      rainCtx = null;
      rainColumns = [];
    }
    function formatPath(uri) {
      try {
        const pathname = new URL(uri).pathname;
        const home = "/home/";
        const homeIdx = pathname.indexOf(home);
        if (homeIdx === 0) {
          const parts = pathname.substring(home.length).split("/");
          if (parts.length > 1) {
            return "~/" + parts.slice(1).join("/");
          }
        }
        return pathname;
      } catch {
        return uri;
      }
    }
    function formatTime(timestamp) {
      const diff = Date.now() - timestamp;
      const minutes = Math.floor(diff / 6e4);
      if (minutes < 1) return "Just now";
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days}d ago`;
      return new Date(timestamp).toLocaleDateString();
    }
    function render() {
      if (hasSessions) {
        welcomeScreen.style.display = "none";
        root.style.display = "";
        document.body.classList.remove("welcome-active");
        stopRain();
        return;
      }
      document.body.classList.add("welcome-active");
      welcomeScreen.style.display = "flex";
      root.style.display = "none";
      const existingCanvas = rainCanvas;
      welcomeScreen.innerHTML = "";
      if (existingCanvas) {
        welcomeScreen.appendChild(existingCanvas);
      }
      startRain();
      const card = document.createElement("div");
      card.className = "welcome-card";
      const logoWrap = document.createElement("div");
      logoWrap.className = "welcome-logo";
      const logoImg = document.createElement("img");
      logoImg.src = (window.mediaUrl || "../../eca-webview/dist") + "/logo.png";
      logoImg.alt = "";
      logoImg.draggable = false;
      logoWrap.appendChild(logoImg);
      card.appendChild(logoWrap);
      const header = document.createElement("div");
      header.className = "welcome-header";
      const title = document.createElement("h1");
      title.className = "welcome-title";
      const words = ["Editor", "Code", "Assistant"];
      words.forEach((word, wi) => {
        const lead = document.createElement("span");
        lead.className = "welcome-title-lead";
        lead.textContent = word[0].toUpperCase();
        title.appendChild(lead);
        const tail = document.createElement("span");
        tail.className = "welcome-title-tail";
        tail.textContent = word.slice(1).toLowerCase();
        title.appendChild(tail);
        if (wi < words.length - 1) {
          const space = document.createElement("span");
          space.className = "welcome-title-space";
          space.innerHTML = "&nbsp;";
          title.appendChild(space);
        }
      });
      const subtitle = document.createElement("p");
      subtitle.className = "welcome-subtitle";
      subtitle.textContent = "Open a folder to start a workspace session";
      header.appendChild(title);
      header.appendChild(subtitle);
      card.appendChild(header);
      setTimeout(() => {
        title.classList.add("collapsed");
      }, 2200);
      const openBtn = document.createElement("button");
      openBtn.className = "welcome-open-btn";
      openBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>New Session';
      openBtn.addEventListener("click", () => {
        window.ecaDesktop?.createSession();
      });
      card.appendChild(openBtn);
      if (recentWorkspaces.length > 0) {
        const divider = document.createElement("div");
        divider.className = "welcome-divider";
        card.appendChild(divider);
        const recentsSection = document.createElement("div");
        recentsSection.className = "welcome-recents";
        const recentsTitle = document.createElement("h2");
        recentsTitle.className = "welcome-recents-title";
        recentsTitle.textContent = "Recent";
        recentsSection.appendChild(recentsTitle);
        const recentsList = document.createElement("div");
        recentsList.className = "welcome-recents-list";
        recentWorkspaces.forEach((ws) => {
          const item = document.createElement("div");
          item.className = "welcome-recent-item";
          const info = document.createElement("div");
          info.className = "welcome-recent-info";
          const name = document.createElement("span");
          name.className = "welcome-recent-name";
          name.textContent = ws.name;
          const pathEl = document.createElement("span");
          pathEl.className = "welcome-recent-path";
          pathEl.textContent = formatPath(ws.uri);
          info.appendChild(name);
          info.appendChild(pathEl);
          const time = document.createElement("span");
          time.className = "welcome-recent-time";
          time.textContent = formatTime(ws.lastOpened);
          item.appendChild(info);
          item.appendChild(time);
          item.addEventListener("click", () => {
            window.ecaDesktop?.createSession(ws.uri);
          });
          recentsList.appendChild(item);
        });
        recentsSection.appendChild(recentsList);
        card.appendChild(recentsSection);
      }
      welcomeScreen.appendChild(card);
    }
    function updateVisibility(sessions) {
      hasSessions = sessions.length > 0;
      render();
    }
    if (window.ecaDesktop) {
      window.ecaDesktop.onWelcomeData((data) => {
        recentWorkspaces = data.recentWorkspaces || [];
        render();
      });
      window.ecaDesktop.onSessionListUpdate((data) => {
        updateVisibility(data.sessions);
      });
    }
    render();
  })();
})();
