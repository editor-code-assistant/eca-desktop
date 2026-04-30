/**
 * ECA Desktop — Preferences bootstrap
 *
 * Extracted from the former inline `<script>` block in preferences.html
 * so that the renderer CSP can drop `'unsafe-inline'` from `script-src`.
 *
 * Responsibilities:
 *   - Opt the preferences window into theme.css by setting the
 *     `data-editor="desktop"` attribute on the root <html>, which scopes
 *     all `--eca-*` custom properties. (Pre-0.6.4 this was "web"; it
 *     moved to "desktop" alongside the eca-webview bump in commit
 *     b44ce16 — see theme.css for the full rationale.)
 *   - Add a `platform-darwin` body class on macOS for platform
 *     specific styling.
 *
 * Typing note: same pattern as `index-bootstrap.ts` — we cast `window`
 * locally instead of `declare global`-ing, to avoid conflicting with
 * the different ecaDesktop shapes declared by `sidebar.ts`,
 * `welcome.ts`, and `preferences.ts`.
 */

export {};

interface EcaDesktopPlatformBridge {
    platform?: string;
}

const win = window as unknown as { ecaDesktop?: EcaDesktopPlatformBridge };

// theme.css scopes its --eca-* variables to html[data-editor="desktop"],
// so opt in here too. The preferences window doesn't embed the
// eca-webview React app, so nothing else will set this attribute — we
// own it for the lifetime of the window.
document.documentElement.setAttribute('data-editor', 'desktop');

if (win.ecaDesktop && win.ecaDesktop.platform === 'darwin') {
    document.body.classList.add('platform-darwin');
}
