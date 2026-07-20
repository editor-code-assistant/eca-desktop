/**
 * ECA Desktop — Input Dialog Window
 *
 * Renders the modal prompt used to serve `editor/readInput` requests
 * from the embedded eca-webview (provider login method picker, API-key
 * entry, prompt-command arguments, …).
 *
 * Two modes, driven by the config fetched from main:
 *   - options: a vertical pick list; clicking (or Enter on a focused
 *     row) submits that option's label.
 *   - input: a single text field (type=password when `password`),
 *     submitted via the OK button or Enter.
 *
 * Escape, the Cancel button, or closing the window all resolve `null`
 * on the main side.
 */
export {};

import { initThemeBootstrap } from './theme-bootstrap';

initThemeBootstrap();

interface InputDialogConfig {
    title: string;
    placeholder: string;
    options: string[];
    password: boolean;
}

interface InputDialogApi {
    platform?: string;
    getInputDialogConfig: () => Promise<InputDialogConfig | null>;
    submitInputDialog: (value: string | null) => void;
}

// Local cast instead of `declare global` — same rationale as the other
// renderer entry points (each bundle declares its own ecaDesktop shape;
// global declarations would collide in the shared tsc program).
const api = (window as unknown as { ecaDesktop?: InputDialogApi }).ecaDesktop;

if (api?.platform === 'darwin') {
    document.body.classList.add('platform-darwin');
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function render(config: InputDialogConfig): void {
    const root = document.getElementById('dialog-root');
    if (!root || !api) return;

    const submit = (value: string | null) => api.submitInputDialog(value);

    root.appendChild(el('div', 'dialog-title', config.title));

    let confirm: (() => void) | null = null;

    if (config.options.length > 0) {
        const list = el('div', 'dialog-options');
        for (const option of config.options) {
            const btn = el('button', 'dialog-option', option);
            btn.type = 'button';
            btn.addEventListener('click', () => submit(option));
            list.appendChild(btn);
        }
        root.appendChild(list);
        (list.firstElementChild as HTMLButtonElement | null)?.focus();
    } else {
        const input = el('input', 'dialog-input');
        input.type = config.password ? 'password' : 'text';
        input.placeholder = config.placeholder;
        input.spellcheck = false;
        root.appendChild(input);
        confirm = () => submit(input.value);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirm?.();
            }
        });
        input.focus();
    }

    const buttons = el('div', 'dialog-buttons');
    const cancelBtn = el('button', 'dialog-btn', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => submit(null));
    buttons.appendChild(cancelBtn);

    if (confirm) {
        const okBtn = el('button', 'dialog-btn primary', 'OK');
        okBtn.type = 'button';
        okBtn.addEventListener('click', () => confirm?.());
        buttons.appendChild(okBtn);
    }
    root.appendChild(buttons);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            submit(null);
        }
    });
}

(async function boot() {
    if (!api || typeof api.getInputDialogConfig !== 'function') {
        console.error('[InputDialog] ecaDesktop bridge is not available');
        return;
    }
    try {
        const config = await api.getInputDialogConfig();
        if (!config) {
            console.error('[InputDialog] No pending dialog config for this window');
            api.submitInputDialog(null);
            return;
        }
        render(config);
    } catch (err) {
        console.error('[InputDialog] Failed to fetch config:', err);
        api.submitInputDialog(null);
    }
})();
