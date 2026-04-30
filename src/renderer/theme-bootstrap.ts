/**
 * ECA Desktop — Theme Bootstrap
 *
 * Imported by every renderer entry (preferences, sidebar, welcome) so
 * each Electron window:
 *   1. Applies a theme synchronously on first paint, using a small
 *      localStorage cache to avoid a FOUC (flash of the default theme
 *      while we wait for the async IPC round-trip).
 *   2. Reconciles with the persisted value from the main-process
 *      preferences store via `window.ecaDesktop.getPreferences()`.
 *   3. Live-updates when preferences change in another window (the
 *      main process broadcasts `preferences-updated` to every
 *      BrowserWindow, and the preload bridges that to
 *      `onPreferencesUpdated`).
 *
 * Idempotent: calling initThemeBootstrap() more than once in the same
 * document is a no-op after the first successful call.
 *
 * This file intentionally does not extend the global Window interface
 * — each entry bundle declares its own `ecaDesktop` shape, and adding
 * a third conflicting declaration would cause TypeScript errors. We
 * read through a narrow local interface via a cast instead.
 */

export type Theme = 'light' | 'dark';

interface ThemeBridge {
    getPreferences: () => Promise<{ theme?: Theme } | undefined>;
    onPreferencesUpdated: (cb: (prefs: { theme?: Theme }) => void) => void;
}

interface InitFlagHolder {
    __ecaThemeBootstrapInitialized?: boolean;
}

const VALID_THEMES = ['light', 'dark'] as const;
const THEME_CACHE_KEY = 'eca-desktop-theme-cache';
const DEFAULT_THEME: Theme = 'dark';

function resolveTheme(value: unknown): Theme {
    return typeof value === 'string' && (VALID_THEMES as readonly string[]).includes(value)
        ? (value as Theme)
        : DEFAULT_THEME;
}

function readCachedTheme(): Theme {
    try {
        return resolveTheme(localStorage.getItem(THEME_CACHE_KEY));
    } catch {
        // Storage may be unavailable (private browsing, sandbox, etc.)
        return DEFAULT_THEME;
    }
}

function writeCachedTheme(theme: Theme): void {
    try {
        localStorage.setItem(THEME_CACHE_KEY, theme);
    } catch {
        // Accept a minor FOUC on next open if storage is unavailable.
    }
}

function applyTheme(theme: Theme): void {
    const html = document.documentElement;
    // theme.css scopes its --eca-* variables to html[data-editor="desktop"].
    //
    // The embedded eca-webview bundle reads localStorage.editor (set to
    // "desktop" by index-bootstrap.ts) and assigns
    // `document.documentElement.dataset.editor = "desktop"` when it
    // mounts. We seed the same attribute synchronously here so the
    // sidebar / welcome screen render with the correct theme on first
    // paint — before the webview module has finished loading. After the
    // webview mounts, both sides agree on "desktop", so there is no
    // attribute-flicker fight (which would otherwise break the webview's
    // own [data-editor="desktop"] modal-card prompt border).
    if (html.getAttribute('data-editor') !== 'desktop') {
        html.setAttribute('data-editor', 'desktop');
    }
    html.setAttribute('data-theme', theme);
    writeCachedTheme(theme);
}

export function initThemeBootstrap(): void {
    const holder = window as unknown as InitFlagHolder;
    if (holder.__ecaThemeBootstrapInitialized) return;
    holder.__ecaThemeBootstrapInitialized = true;

    // Synchronous first paint — use the last-known theme from
    // localStorage so we don't flash the default dark theme for users
    // who have opted into light (or vice-versa on a future default
    // change).
    applyTheme(readCachedTheme());

    const api = (window as unknown as { ecaDesktop?: ThemeBridge }).ecaDesktop;
    if (!api || typeof api.getPreferences !== 'function') {
        // Preload bridge unavailable — keep the cached theme and bail.
        return;
    }

    api
        .getPreferences()
        .then((prefs) => applyTheme(resolveTheme(prefs?.theme)))
        .catch((err) => {
            console.error('[ThemeBootstrap] Failed to load preferences:', err);
        });

    if (typeof api.onPreferencesUpdated === 'function') {
        api.onPreferencesUpdated((prefs) => {
            applyTheme(resolveTheme(prefs?.theme));
        });
    }
}
