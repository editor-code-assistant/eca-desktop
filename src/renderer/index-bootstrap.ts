/**
 * ECA Desktop — Index bootstrap
 *
 * Extracted from the former inline `<script>` block in index.html so that
 * the renderer CSP can drop `'unsafe-inline'` from `script-src`.
 *
 * Responsibilities:
 *   - Expose `window.mediaUrl` for eca-webview assets (logos, etc.).
 *   - Tell eca-webview which pluggable transport to use by setting the
 *     `editor` localStorage key to `"web"`.
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
localStorage.setItem('editor', '"web"');

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
