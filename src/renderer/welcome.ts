/**
 * ECA Desktop — Welcome Screen
 *
 * Shown when no sessions are active. Allows opening a folder
 * or selecting a recent workspace.
 */
export {};

import { initThemeBootstrap } from './theme-bootstrap';

// Idempotent — safe to call alongside sidebar.ts which also invokes it.
// Keeps the welcome screen painting in the correct theme even if the
// sidebar bundle ever loads after this one.
initThemeBootstrap();

interface RecentWorkspace {
    uri: string;
    name: string;
    lastOpened: number;
}

interface WelcomeData {
    recentWorkspaces: RecentWorkspace[];
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
    createSession: (uri?: string) => void;
    removeSession: (sessionId: string) => void;
    onSessionListUpdate: (callback: (data: SessionListUpdate) => void) => void;
    onWelcomeData: (callback: (data: WelcomeData) => void) => void;
}

declare global {
    interface Window {
        ecaDesktop?: EcaDesktopApi;
    }
}

(function () {
    'use strict';

    const welcomeScreen = document.getElementById('welcome-screen')!;
    const root = document.getElementById('root')!;

    let recentWorkspaces: RecentWorkspace[] = [];
    let hasSessions = false;

    // ── Code Rain (subtle falling code characters) ──

    const snippets = [
        'const ', 'let ', 'fn ', 'def ', 'import ', 'export ', 'return ',
        'async ', 'await ', 'if ', 'else ', 'for ', 'while ', 'match ',
        '=> ', '-> ', ':: ', '() ', '[] ', '{}', '..', '// ',
        'true', 'false', 'null', 'nil', 'self', 'this',
        'pub ', 'use ', 'mod ', 'impl ', 'trait ', 'type ',
        '<T>', 'Ok()', 'Err', 'Some', 'None',
        'println!', 'console.', 'print(', 'log(',
        '= ', '!= ', '== ', '>= ', '<= ', '&& ', '|| ',
        '0x', '127', '443', '8080', '3000',
        'utf-8', 'json', 'ssh', 'tcp', 'http',
        'fn main', 'class ', 'struct ', 'enum ',
        '.map(', '.filter(', '.then(', '.catch(',
        'Result<', 'Vec<', 'Option<', 'Promise<',
        '|> ', ':ok', ':error', 'defmodule ',
    ];

    const randomSnippet = () => snippets[Math.floor(Math.random() * snippets.length)];

    interface RainColumn {
        x: number;
        y: number;
        speed: number;
        opacity: number;
        chars: string;
        charIndex: number;
        fontSize: number;
    }

    let rainCanvas: HTMLCanvasElement | null = null;
    let rainCtx: CanvasRenderingContext2D | null = null;
    let rainColumns: RainColumn[] = [];
    let rainAnimId = 0;
    let rainW = 0;
    let rainH = 0;

    function makeColumn(x: number, randomizeY: boolean): RainColumn {
        return {
            x,
            y: randomizeY ? Math.random() * rainH : -20,
            speed: 0.15 + Math.random() * 0.35,
            opacity: 0.12 + Math.random() * 0.14,
            chars: randomSnippet() + randomSnippet() + ' ' + randomSnippet(),
            charIndex: 0,
            fontSize: 10 + Math.floor(Math.random() * 3),
        };
    }

    function initRainColumns(): void {
        const colGap = 28;
        const count = Math.ceil(rainW / colGap);
        rainColumns = Array.from({ length: count }, (_, i) => makeColumn(i * colGap, true));
    }

    function resizeRain(): void {
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

    function drawRain(): void {
        if (!rainCtx) return;
        rainCtx.clearRect(0, 0, rainW, rainH);

        const centerX = rainW / 2;
        const centerY = rainH / 2;
        // Normalize distance so edge = 1, center = 0
        const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

        for (const col of rainColumns) {
            rainCtx.font = `${col.fontSize}px "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace`;
            const lineH = col.fontSize + 4;
            const visible = col.chars.slice(0, Math.floor(col.charIndex));

            // Fade columns near center — uses horizontal distance primarily
            const dx = Math.abs(col.x - centerX) / centerX; // 0 at center, 1 at edge
            // Smooth curve: almost invisible at center, full at edges
            const centerFade = Math.pow(Math.min(dx * 1.4, 1), 2);

            for (let j = 0; j < visible.length; j++) {
                const distFromHead = visible.length - 1 - j;
                const fade = Math.max(0, 1 - distFromHead * 0.08);

                // Also fade vertically near center
                const charY = col.y + j * lineH;
                const dy = Math.abs(charY - centerY) / centerY;
                const vertFade = Math.pow(Math.min(dy * 1.2, 1), 1.5);
                const spatialFade = Math.max(centerFade, vertFade);

                const alpha = col.opacity * fade * spatialFade;

                if (j === visible.length - 1) {
                    rainCtx.fillStyle = `rgba(0, 200, 220, ${Math.min(alpha * 3, 0.6)})`;
                } else {
                    rainCtx.fillStyle = `rgba(195, 200, 205, ${alpha})`;
                }

                rainCtx.fillText(visible[j], col.x, col.y + j * lineH);
            }

            col.charIndex += col.speed * 0.5;
            col.y += col.speed;

            if (col.y > rainH + 40) {
                col.y = -(col.chars.length * (col.fontSize + 4));
                col.chars = randomSnippet() + randomSnippet() + ' ' + randomSnippet();
                col.charIndex = 0;
                col.speed = 0.15 + Math.random() * 0.35;
                col.opacity = 0.06 + Math.random() * 0.09;
            }

            if (col.charIndex > col.chars.length + 6) {
                col.chars = randomSnippet() + randomSnippet() + ' ' + randomSnippet();
                col.charIndex = 0;
            }
        }

        rainAnimId = requestAnimationFrame(drawRain);
    }

    function startRain(): void {
        if (rainCanvas) return; // already running
        rainCanvas = document.createElement('canvas');
        rainCanvas.className = 'welcome-rain';
        rainCanvas.setAttribute('aria-hidden', 'true');
        welcomeScreen.insertBefore(rainCanvas, welcomeScreen.firstChild);

        rainCtx = rainCanvas.getContext('2d');
        if (!rainCtx) return;

        resizeRain();
        rainAnimId = requestAnimationFrame(drawRain);
        window.addEventListener('resize', resizeRain);
    }

    function stopRain(): void {
        cancelAnimationFrame(rainAnimId);
        window.removeEventListener('resize', resizeRain);
        if (rainCanvas && rainCanvas.parentNode) {
            rainCanvas.parentNode.removeChild(rainCanvas);
        }
        rainCanvas = null;
        rainCtx = null;
        rainColumns = [];
    }

    function formatPath(uri: string): string {
        try {
            const pathname = new URL(uri).pathname;
            // Shorten home directory
            const home = '/home/';
            const homeIdx = pathname.indexOf(home);
            if (homeIdx === 0) {
                const parts = pathname.substring(home.length).split('/');
                if (parts.length > 1) {
                    return '~/' + parts.slice(1).join('/');
                }
            }
            return pathname;
        } catch {
            return uri;
        }
    }

    function formatTime(timestamp: number): string {
        const diff = Date.now() - timestamp;
        const minutes = Math.floor(diff / 60000);
        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(timestamp).toLocaleDateString();
    }

    function render(): void {
        if (hasSessions) {
            root.style.display = '';
            const logo = welcomeScreen.querySelector(
                '.welcome-logo .welcome-logo-icon',
            ) as HTMLElement | null;
            if (logo) logo.style.animation = 'none';
            welcomeScreen.classList.add('fade-out');
            setTimeout(() => {
                welcomeScreen.style.display = 'none';
                document.body.classList.remove('welcome-active');
                stopRain();
            }, 150);
            return;
        }

        welcomeScreen.classList.remove('fade-out');
        document.body.classList.add('welcome-active');
        welcomeScreen.style.display = 'flex';
        root.style.display = 'none';

        // Preserve the rain canvas while clearing other content
        const existingCanvas = rainCanvas;
        welcomeScreen.innerHTML = '';
        if (existingCanvas) {
            welcomeScreen.appendChild(existingCanvas);
        }

        startRain();

        const card = document.createElement('div');
        card.className = 'welcome-card';

        // Logo — rendered as a CSS-masked <span> so the mark follows the
        // active theme (see .welcome-logo-icon in welcome.css). Switching
        // away from <img> means we no longer depend on the eca-webview
        // dist PNG at runtime, and the color can adapt per theme via
        // the --eca-logo-fg custom property.
        const logoWrap = document.createElement('div');
        logoWrap.className = 'welcome-logo';

        const logoIcon = document.createElement('span');
        logoIcon.className = 'welcome-logo-icon';
        logoIcon.setAttribute('role', 'img');
        logoIcon.setAttribute('aria-label', 'ECA');
        logoWrap.appendChild(logoIcon);
        card.appendChild(logoWrap);

        // Title — animated "Editor Code Assistant" → "ECA"
        const header = document.createElement('div');
        header.className = 'welcome-header';

        const title = document.createElement('h1');
        title.className = 'welcome-title';

        // Build spans: highlighted first letters + collapsible tails + spaces
        const words = ['Editor', 'Code', 'Assistant'];
        words.forEach((word, wi) => {
            // Leading letter (E, C, A) — stays visible, always uppercase
            const lead = document.createElement('span');
            lead.className = 'welcome-title-lead';
            lead.textContent = word[0].toUpperCase();
            title.appendChild(lead);

            // Remaining letters — lowercase, will collapse
            const tail = document.createElement('span');
            tail.className = 'welcome-title-tail';
            tail.textContent = word.slice(1).toLowerCase();
            title.appendChild(tail);

            // Space between words (not after last)
            if (wi < words.length - 1) {
                const space = document.createElement('span');
                space.className = 'welcome-title-space';
                space.innerHTML = '&nbsp;';
                title.appendChild(space);
            }
        });

        const subtitle = document.createElement('p');
        subtitle.className = 'welcome-subtitle';
        subtitle.textContent = 'Open a folder to start a workspace session';

        header.appendChild(title);
        header.appendChild(subtitle);
        card.appendChild(header);

        // Trigger collapse animation after a delay
        setTimeout(() => {
            title.classList.add('collapsed');
        }, 2200);

        // Open Folder button with folder icon
        const openBtn = document.createElement('button');
        openBtn.className = 'welcome-open-btn';
        openBtn.innerHTML =
            '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
            'New Session';
        openBtn.addEventListener('click', () => {
            window.ecaDesktop?.createSession();
        });
        card.appendChild(openBtn);

        // Recent workspaces
        if (recentWorkspaces.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'welcome-divider';
            card.appendChild(divider);

            const recentsSection = document.createElement('div');
            recentsSection.className = 'welcome-recents';

            const recentsTitle = document.createElement('h2');
            recentsTitle.className = 'welcome-recents-title';
            recentsTitle.textContent = 'Recent';
            recentsSection.appendChild(recentsTitle);

            const recentsList = document.createElement('div');
            recentsList.className = 'welcome-recents-list';

            recentWorkspaces.forEach((ws) => {
                const item = document.createElement('div');
                item.className = 'welcome-recent-item';

                const info = document.createElement('div');
                info.className = 'welcome-recent-info';

                const name = document.createElement('span');
                name.className = 'welcome-recent-name';
                name.textContent = ws.name;

                const pathEl = document.createElement('span');
                pathEl.className = 'welcome-recent-path';
                pathEl.textContent = formatPath(ws.uri);

                info.appendChild(name);
                info.appendChild(pathEl);

                const time = document.createElement('span');
                time.className = 'welcome-recent-time';
                time.textContent = formatTime(ws.lastOpened);

                item.appendChild(info);
                item.appendChild(time);

                item.addEventListener('click', () => {
                    window.ecaDesktop?.createSession(ws.uri);
                });

                recentsList.appendChild(item);
            });

            recentsSection.appendChild(recentsList);
            card.appendChild(recentsSection);
        }

        welcomeScreen.appendChild(card);
    }

    function updateVisibility(sessions: SessionInfo[]): void {
        hasSessions = sessions.length > 0;
        render();
    }

    // ── IPC listeners ──
    if (window.ecaDesktop) {
        window.ecaDesktop.onWelcomeData((data: WelcomeData) => {
            recentWorkspaces = data.recentWorkspaces || [];
            render();
        });

        window.ecaDesktop.onSessionListUpdate((data: SessionListUpdate) => {
            updateVisibility(data.sessions);
        });
    }

    // Initial render
    render();
})();
