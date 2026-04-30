/**
 * ECA Desktop — Index bootstrap
 *
 * Extracted from the former inline `<script>` block in index.html so that
 * the renderer CSP can drop `'unsafe-inline'` from `script-src`.
 *
 * Responsibilities:
 *   - Expose `window.mediaUrl` for eca-webview assets (logos, etc.).
 *   - Tell eca-webview which pluggable transport to use by setting the
 *     `editor` localStorage key to `"desktop"`. eca-webview reuses the
 *     web pluggable transport (`window.__ecaWebTransport`) for the
 *     desktop host but flips host-specific styling (e.g. the prompt-
 *     area card border) on the `[data-editor="desktop"]` selector.
 *   - Add a `platform-darwin` body class on macOS so the custom
 *     `.desktop-titlebar` drag region renders (and macOS-specific
 *     padding kicks in).
 *   - Install the in/out transport bridge between eca-webview and the
 *     main process via the `window.ecaDesktop` preload API.
 *
 * Typing note: we deliberately DO NOT `declare global { interface Window }`
 * here. Multiple renderer entry points (`sidebar.ts`, `welcome.ts`,
 * `preferences.ts`) each add their own `ecaDesktop` shape under a
 * separate esbuild bundle; at runtime those bundles never run together
 * (each HTML page loads exactly one), but `tsc` sees all of them in the
 * same program and rejects the conflicting declarations. Following
 * `theme-bootstrap.ts`, we cast locally to the shape this bootstrap
 * needs and leave the global interface alone.
 */

export {};

type WebviewMessage = unknown;

interface EcaDesktopTransportBridge {
    send: (message: WebviewMessage) => void;
    onMessage: (callback: (message: WebviewMessage) => void) => void;
    platform?: string;
    isDev?: boolean;
    webviewDevUrl?: string;
}

interface WebTransport {
    send: (message: WebviewMessage) => void;
}

interface IndexWindow {
    ecaDesktop?: EcaDesktopTransportBridge;
    mediaUrl?: string;
    __ecaWebTransport?: WebTransport;
}

const win = window as unknown as IndexWindow & Window;

// Set media URL for eca-webview assets (logo, etc.)
win.mediaUrl = '../../eca-webview/dist';

// Set editor type so eca-webview uses the pluggable web transport
// (eca-webview's webviewSend treats "desktop" identically to "web") and
// applies desktop-only styling via the `[data-editor="desktop"]` selector.
localStorage.setItem('editor', '"desktop"');

// Detect platform and add class for platform-specific styling
if (win.ecaDesktop && win.ecaDesktop.platform === 'darwin') {
    document.body.classList.add('platform-darwin');
}

// Wire up the transport bridge
// Outbound: webview -> main process -> ECA server
win.__ecaWebTransport = {
    send: function (message) {
        if (win.ecaDesktop) {
            win.ecaDesktop.send(message);
        }
    },
};

// Inbound: ECA server -> main process -> webview
if (win.ecaDesktop) {
    win.ecaDesktop.onMessage(function (message) {
        win.postMessage(message, '*');
    });
}

// ── Load the React bundle (eca-webview) ──
//
// In dev mode (`npm run dev` or `npm run dev:app`) we load it from the
// Vite dev server so a single webview can be shared with eca-vscode and
// eca-intellij during development. In production we load the bundled
// artifact from the in-repo `eca-webview/dist`.
//
// This used to be a static `<script>` tag in index.html — moved here so
// the URL can be chosen at runtime based on flags forwarded from main.
const isDev = win.ecaDesktop?.isDev === true;
const webviewBaseUrl = win.ecaDesktop?.webviewDevUrl ?? 'http://localhost:5173';

if (isDev) {
    // React Refresh preamble — required by `@vitejs/plugin-react`.
    // Without this the React plugin throws "can't detect preamble" and
    // the app fails to mount. Mirrors the inline preamble eca-vscode
    // injects in `getWebviewContent` (see eca-vscode/src/webview.ts).
    const preamble = document.createElement('script');
    preamble.type = 'module';
    preamble.textContent =
        `import RefreshRuntime from "${webviewBaseUrl}/@react-refresh";\n`
        + `RefreshRuntime.injectIntoGlobalHook(window);\n`
        + `window.$RefreshReg$ = () => {};\n`
        + `window.$RefreshSig$ = () => (type) => type;\n`
        + `window.__vite_plugin_react_preamble_installed__ = true;\n`;
    document.head.appendChild(preamble);

    // Stylesheet (Vite serves `/src/index.css` as a regular CSS file in dev).
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = `${webviewBaseUrl}/src/index.css`;
    document.head.appendChild(styleLink);

    // Main React entrypoint.
    const mainScript = document.createElement('script');
    mainScript.type = 'module';
    mainScript.src = `${webviewBaseUrl}/src/main.tsx`;
    document.body.appendChild(mainScript);
} else {
    // Production: load the pre-built artifacts from the in-repo dist.
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = '../../eca-webview/dist/assets/index.css';
    document.head.appendChild(styleLink);

    const mainScript = document.createElement('script');
    mainScript.type = 'module';
    mainScript.src = '../../eca-webview/dist/assets/index.js';
    document.body.appendChild(mainScript);
}
