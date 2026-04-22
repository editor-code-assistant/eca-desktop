import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';

// ── electron-updater mock ────────────────────────────────────────
// `autoUpdater` in the real module is an EventEmitter — emulate that so
// tests can drive `update-available`, `update-downloaded`, and `error`.
type UpdaterMock = EventEmitter & {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    checkForUpdates: ReturnType<typeof vi.fn>;
    downloadUpdate: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
};

function makeUpdater(): UpdaterMock {
    const ee = new EventEmitter() as UpdaterMock;
    ee.autoDownload = true; // start with the non-configured default to
    ee.autoInstallOnAppQuit = false; // verify setupAutoUpdater flips them
    ee.checkForUpdates = vi.fn(async () => ({} as unknown));
    ee.downloadUpdate = vi.fn(async () => [] as unknown);
    ee.quitAndInstall = vi.fn();
    return ee;
}

let updater: UpdaterMock = makeUpdater();

vi.mock('electron-updater', () => ({
    get autoUpdater() {
        return updater;
    },
}));

// ── electron mock ────────────────────────────────────────────────
const showMessageBox = vi.fn();
vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
    dialog: {
        showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    },
}));

function makeFakeWindow() {
    return {} as unknown as BrowserWindow;
}

// Let any pending microtasks (awaited .then() chains inside handlers) run.
const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('setupAutoUpdater', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        updater = makeUpdater();
        showMessageBox.mockReset();
        // Default resolved value — handlers dereference `response` so we
        // need a shape, not undefined.
        showMessageBox.mockResolvedValue({ response: 1 });
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.resetModules();
    });

    async function loadAndSetup() {
        const { setupAutoUpdater } = await import('../updater');
        setupAutoUpdater(makeFakeWindow());
    }

    it('configures autoUpdater flags and kicks off a check', async () => {
        await loadAndSetup();
        expect(updater.autoDownload).toBe(false);
        expect(updater.autoInstallOnAppQuit).toBe(true);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('shows an "Update Available" dialog and downloads when user accepts', async () => {
        showMessageBox.mockResolvedValueOnce({ response: 0 }); // click Download
        await loadAndSetup();

        updater.emit('update-available', { version: '1.2.3' });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(showMessageBox).toHaveBeenCalledTimes(1);
        const [, opts] = showMessageBox.mock.calls[0];
        expect(opts.title).toBe('Update Available');
        expect(opts.message).toContain('1.2.3');
        expect(opts.buttons).toEqual(['Download', 'Later']);
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('does not download when user declines "Update Available"', async () => {
        showMessageBox.mockResolvedValueOnce({ response: 1 }); // click Later
        await loadAndSetup();

        updater.emit('update-available', { version: '9.9.9' });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(updater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('shows an "Update Ready" dialog on update-downloaded and restarts on Restart Now', async () => {
        showMessageBox.mockResolvedValueOnce({ response: 0 }); // Restart Now
        await loadAndSetup();

        updater.emit('update-downloaded');
        await flushMicrotasks();
        await flushMicrotasks();

        expect(showMessageBox).toHaveBeenCalledTimes(1);
        const [, opts] = showMessageBox.mock.calls[0];
        expect(opts.title).toBe('Update Ready');
        expect(opts.buttons).toEqual(['Restart Now', 'Later']);
        expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it('logs errors and does not throw on error events', async () => {
        await loadAndSetup();

        expect(() => updater.emit('error', new Error('boom'))).not.toThrow();

        // Known gap: at time of writing, updater.ts only `console.error`s
        // on failure — it does NOT surface a dialog. That means a Linux
        // `.deb` user whose update pipeline fails gets nothing visible.
        // This assertion codifies the current behaviour; flip it if the
        // module starts surfacing errors via `dialog.showErrorBox` etc.
        expect(consoleErrorSpy).toHaveBeenCalled();
        expect(showMessageBox).not.toHaveBeenCalled();
    });

    it('swallows a rejected checkForUpdates without throwing', async () => {
        updater.checkForUpdates = vi.fn(() => Promise.reject(new Error('network')));
        await loadAndSetup();
        await flushMicrotasks();
        await flushMicrotasks();
        // The `.catch` branch logs via console.error — no assertion needed
        // beyond "didn't reject up the stack".
        expect(consoleErrorSpy).toHaveBeenCalled();
    });
});
