/**
 * ECA Desktop — Preferences Window
 *
 * Desktop-app level preferences (theme, server binary override; future:
 * keybindings, updater behavior, …).
 *
 * Layout: left-nav of categories + right content pane. A new category
 * slots in by appending to CATEGORIES and adding a render* function.
 */
export {};

import { initThemeBootstrap, type Theme } from './theme-bootstrap';

// Apply the persisted theme as early as possible so the Preferences
// window paints in the correct colors on first open.
initThemeBootstrap();

interface Preferences {
    schemaVersion: 1;
    serverBinaryPath?: string;
    theme?: Theme;
}

interface SetPreferencesResult {
    ok: boolean;
    error?: string;
    preferences?: Preferences;
}

interface PreferencesApi {
    platform: string;
    getPreferences: () => Promise<Preferences>;
    setPreferences: (patch: Partial<Preferences>) => Promise<SetPreferencesResult>;
    pickServerBinary: () => Promise<string | null>;
    onPreferencesUpdated: (cb: (prefs: Preferences) => void) => void;
    removePreferencesUpdatedListener: (cb: (prefs: Preferences) => void) => void;
}

declare global {
    interface Window {
        ecaDesktop?: PreferencesApi & Record<string, unknown>;
    }
}

interface Category {
    id: string;
    label: string;
    /** Inner SVG markup for a 24×24 viewBox icon. */
    iconSvg: string;
}

const CATEGORIES: Category[] = [
    {
        id: 'general',
        label: 'General',
        iconSvg:
            '<circle cx="12" cy="12" r="3"/>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    },
    {
        id: 'server',
        label: 'Server',
        iconSvg:
            '<rect x="2" y="3" width="20" height="7" rx="2"/>' +
            '<rect x="2" y="14" width="20" height="7" rx="2"/>' +
            '<line x1="6" y1="6.5" x2="6.01" y2="6.5"/>' +
            '<line x1="6" y1="17.5" x2="6.01" y2="17.5"/>',
    },
];

(function () {
    'use strict';

    const api = window.ecaDesktop;
    if (!api) {
        console.error('[Preferences] ecaDesktop bridge is not available');
        return;
    }

    const root = document.getElementById('prefs-root')!;
    let activeCategoryId: string = CATEGORIES[0].id;
    let current: Preferences = { schemaVersion: 1 };

    const nav = document.createElement('nav');
    nav.className = 'prefs-nav';

    const pane = document.createElement('section');
    pane.className = 'prefs-pane';

    root.appendChild(nav);
    root.appendChild(pane);

    // ── Navigation ──
    function renderNav(): void {
        nav.innerHTML = '';
        for (const cat of CATEGORIES) {
            const item = document.createElement('div');
            item.className =
                'prefs-nav-item' + (cat.id === activeCategoryId ? ' active' : '');
            item.innerHTML =
                `<svg class="prefs-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${cat.iconSvg}</svg>` +
                `<span>${cat.label}</span>`;
            item.addEventListener('click', () => {
                activeCategoryId = cat.id;
                renderNav();
                renderPane();
            });
            nav.appendChild(item);
        }
    }

    // ── Shared section helper ──
    function sectionWrapper(title: string, description?: string): HTMLElement {
        const section = document.createElement('div');
        section.className = 'prefs-section';

        const h = document.createElement('h1');
        h.className = 'prefs-section-title';
        h.textContent = title;
        section.appendChild(h);

        if (description) {
            const p = document.createElement('p');
            p.className = 'prefs-section-description';
            p.textContent = description;
            section.appendChild(p);
        }

        return section;
    }

    // ── General section ──
    function renderGeneral(): HTMLElement {
        const section = sectionWrapper(
            'General',
            'Application-wide preferences.',
        );

        section.appendChild(renderThemeField());

        return section;
    }

    /** Theme selector — a native <select> with Dark / Light options.
     *  Changes save immediately and propagate to every open window via
     *  the preferences-updated broadcast, so the effect is visible
     *  without needing a Save button. */
    function renderThemeField(): HTMLElement {
        const field = document.createElement('div');
        field.className = 'prefs-field';

        const label = document.createElement('label');
        label.className = 'prefs-field-label';
        label.htmlFor = 'prefs-theme-select';
        label.textContent = 'Theme';
        field.appendChild(label);

        const row = document.createElement('div');
        row.className = 'prefs-input-row';

        const select = document.createElement('select');
        select.id = 'prefs-theme-select';
        select.className = 'prefs-input prefs-select';

        const options: Array<{ value: Theme; label: string }> = [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
        ];
        for (const opt of options) {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            select.appendChild(option);
        }

        // Current value; default to 'dark' when unset so the dropdown
        // reflects the actual rendered theme.
        select.value = current.theme ?? 'dark';

        const message = document.createElement('div');
        message.className = 'prefs-message';

        function clearMessage(): void {
            message.textContent = '';
            message.classList.remove('error', 'success');
        }

        function showError(msg: string): void {
            message.textContent = msg;
            message.classList.remove('success');
            message.classList.add('error');
        }

        select.addEventListener('change', async () => {
            clearMessage();
            const nextTheme: Theme = select.value === 'light' ? 'light' : 'dark';
            try {
                const result = await api!.setPreferences({ theme: nextTheme });
                if (result.ok) {
                    current = result.preferences ?? current;
                    // No success banner — the theme change is itself
                    // visible confirmation.
                } else {
                    showError(result.error ?? 'Could not save theme.');
                    select.value = current.theme ?? 'dark';
                }
            } catch (err: any) {
                showError(err?.message ?? 'Unexpected error while saving.');
                select.value = current.theme ?? 'dark';
            }
        });

        row.appendChild(select);
        field.appendChild(row);

        const hint = document.createElement('div');
        hint.className = 'prefs-field-hint';
        hint.textContent =
            'Controls the appearance of the sidebar, welcome screen, preferences, and chat.';
        field.appendChild(hint);

        field.appendChild(message);

        return field;
    }

    // ── Server section ──
    function renderServer(): HTMLElement {
        const section = sectionWrapper(
            'Server',
            'Control how the ECA server binary is resolved. When no custom path is set, the latest release is downloaded and managed automatically.',
        );

        const field = document.createElement('div');
        field.className = 'prefs-field';

        const label = document.createElement('label');
        label.className = 'prefs-field-label';
        label.htmlFor = 'server-binary-path';
        label.textContent = 'Custom server binary path';
        field.appendChild(label);

        const row = document.createElement('div');
        row.className = 'prefs-input-row';

        const input = document.createElement('input');
        input.id = 'server-binary-path';
        input.className = 'prefs-input';
        input.type = 'text';
        input.spellcheck = false;
        input.placeholder = 'Leave empty to auto-download (recommended)';
        input.value = current.serverBinaryPath ?? '';
        input.addEventListener('input', clearMessages);
        row.appendChild(input);

        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'prefs-btn prefs-btn-secondary';
        browseBtn.textContent = 'Browse…';
        browseBtn.addEventListener('click', async () => {
            const selected = await api!.pickServerBinary();
            if (selected) {
                input.value = selected;
                clearMessages();
            }
        });
        row.appendChild(browseBtn);

        field.appendChild(row);

        const hint = document.createElement('div');
        hint.className = 'prefs-field-hint';
        hint.textContent =
            'Absolute path to an eca executable. When set, automatic download and version checks are skipped. Changes apply the next time an ECA server starts.';
        field.appendChild(hint);

        const message = document.createElement('div');
        message.className = 'prefs-message';
        field.appendChild(message);

        section.appendChild(field);

        const footer = document.createElement('div');
        footer.className = 'prefs-footer';

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'prefs-btn prefs-btn-secondary';
        clearBtn.textContent = 'Use default (auto-download)';
        clearBtn.addEventListener('click', async () => {
            input.value = '';
            await save('');
        });
        footer.appendChild(clearBtn);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'prefs-btn prefs-btn-primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            await save(input.value);
        });
        footer.appendChild(saveBtn);

        section.appendChild(footer);

        function clearMessages(): void {
            message.textContent = '';
            message.classList.remove('error', 'success');
            input.classList.remove('invalid');
        }

        function showError(msg: string): void {
            message.textContent = msg;
            message.classList.remove('success');
            message.classList.add('error');
            input.classList.add('invalid');
        }

        function showSuccess(msg: string): void {
            message.textContent = msg;
            message.classList.remove('error');
            message.classList.add('success');
            input.classList.remove('invalid');
        }

        async function save(value: string): Promise<void> {
            clearMessages();
            const trimmed = value.trim();
            const patch: Partial<Preferences> = {
                serverBinaryPath: trimmed === '' ? undefined : trimmed,
            };
            try {
                const result = await api!.setPreferences(patch);
                if (result.ok) {
                    current = result.preferences ?? current;
                    showSuccess(
                        trimmed
                            ? 'Saved. New binary will be used on next server start.'
                            : 'Cleared. Auto-download will resume on next server start.',
                    );
                } else {
                    showError(result.error ?? 'Could not save preferences.');
                }
            } catch (err: any) {
                showError(err?.message ?? 'Unexpected error while saving.');
            }
        }

        return section;
    }

    function renderPane(): void {
        pane.innerHTML = '';
        switch (activeCategoryId) {
            case 'server':
                pane.appendChild(renderServer());
                break;
            case 'general':
            default:
                pane.appendChild(renderGeneral());
                break;
        }
    }

    // ── Initial load ──
    api.getPreferences()
        .then((prefs) => {
            current = prefs;
            renderNav();
            renderPane();
        })
        .catch((err) => {
            console.error('[Preferences] Failed to load:', err);
            renderNav();
            renderPane();
        });

    // Re-render on external pref updates (e.g. saved from another window).
    api.onPreferencesUpdated((prefs: Preferences) => {
        current = prefs;
        renderPane();
    });
})();
