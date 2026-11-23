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
const netFetch = vi.fn();
const openExternal = vi.fn();
const getVersion = vi.fn(() => '0.13.0');
vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
    app: {
        getVersion: () => getVersion(),
    },
    dialog: {
        showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    },
    net: {
        fetch: (...args: unknown[]) => netFetch(...args),
    },
    shell: {
        openExternal: (...args: unknown[]) => openExternal(...args),
    },
}));

function makeFakeWindow(destroyed = false) {
    return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
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

    it('skips setup entirely under Flatpak (updates owned by Flatpak)', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        process.env.FLATPAK_ID = 'dev.eca.desktop';
        try {
            await loadAndSetup();
            expect(updater.checkForUpdates).not.toHaveBeenCalled();
            // Flags left at their unconfigured defaults — nothing touched.
            expect(updater.autoDownload).toBe(true);
            expect(updater.autoInstallOnAppQuit).toBe(false);
        } finally {
            delete process.env.FLATPAK_ID;
            consoleLogSpy.mockRestore();
        }
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

// ── Portable Windows exe ─────────────────────────────────────────
// electron-builder's portable launcher exports PORTABLE_EXECUTABLE_FILE;
// electron-updater can't update that build, so the module falls back to
// a GitHub latest-release check + "open download page" notice.

const RELEASE_API = 'https://api.github.com/repos/editor-code-assistant/eca-desktop/releases/latest';
const RELEASE_PAGE = 'https://github.com/editor-code-assistant/eca-desktop/releases/latest';

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

describe('portable Windows build', () => {
    const origPlatform = process.platform;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        updater = makeUpdater();
        showMessageBox.mockReset();
        showMessageBox.mockResolvedValue({ response: 1 });
        netFetch.mockReset();
        netFetch.mockResolvedValue(jsonResponse({ tag_name: 'v0.13.0' }));
        openExternal.mockReset();
        openExternal.mockResolvedValue(undefined);
        getVersion.mockReturnValue('0.13.0');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Users\\me\\Downloads\\eca-win-x64.exe';
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: origPlatform });
        delete process.env.PORTABLE_EXECUTABLE_FILE;
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
        vi.resetModules();
    });

    describe('isPortableWindowsBuild', () => {
        it('is true on win32 when launched by the portable launcher', async () => {
            const { isPortableWindowsBuild } = await import('../updater');
            expect(isPortableWindowsBuild()).toBe(true);
        });

        it('is false on win32 without the portable launcher env', async () => {
            delete process.env.PORTABLE_EXECUTABLE_FILE;
            const { isPortableWindowsBuild } = await import('../updater');
            expect(isPortableWindowsBuild()).toBe(false);
        });

        it('is false off Windows even if the env var leaked', async () => {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            const { isPortableWindowsBuild } = await import('../updater');
            expect(isPortableWindowsBuild()).toBe(false);
        });
    });

    it('setupAutoUpdater skips electron-updater and checks the latest release instead', async () => {
        const { setupAutoUpdater } = await import('../updater');
        setupAutoUpdater(makeFakeWindow());
        await flushMicrotasks();

        expect(updater.checkForUpdates).not.toHaveBeenCalled();
        // Flags left at their unconfigured defaults — nothing touched.
        expect(updater.autoDownload).toBe(true);
        expect(updater.autoInstallOnAppQuit).toBe(false);
        expect(netFetch).toHaveBeenCalledTimes(1);
        expect(netFetch.mock.calls[0][0]).toBe(RELEASE_API);
    });

    describe('notifyIfNewerRelease', () => {
        async function run(win = makeFakeWindow()) {
            const { notifyIfNewerRelease } = await import('../updater');
            await notifyIfNewerRelease(win);
        }

        it('offers the download page for a newer release and opens it on accept', async () => {
            netFetch.mockResolvedValue(jsonResponse({ tag_name: 'v0.14.0' }));
            showMessageBox.mockResolvedValueOnce({ response: 0 }); // Open Download Page
            await run();

            expect(showMessageBox).toHaveBeenCalledTimes(1);
            const [, opts] = showMessageBox.mock.calls[0];
            expect(opts.title).toBe('Update Available');
            expect(opts.message).toContain('0.14.0');
            expect(opts.message).not.toContain('v0.14.0');
            expect(opts.buttons).toEqual(['Open Download Page', 'Later']);
            expect(opts.cancelId).toBe(1);
            expect(openExternal).toHaveBeenCalledWith(RELEASE_PAGE);
        });

        it('does not open anything when the user picks Later', async () => {
            netFetch.mockResolvedValue(jsonResponse({ tag_name: 'v0.14.0' }));
            showMessageBox.mockResolvedValueOnce({ response: 1 });
            await run();

            expect(showMessageBox).toHaveBeenCalledTimes(1);
            expect(openExternal).not.toHaveBeenCalled();
        });

        it('compares versions numerically, not lexicographically', async () => {
            getVersion.mockReturnValue('0.13.9');
            netFetch.mockResolvedValue(jsonResponse({ tag_name: 'v0.13.10' }));
            await run();
            expect(showMessageBox).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['the same version', 'v0.13.0'],
            ['an older version', 'v0.10.3'],
            ['an untagged-v same version', '0.13.0'],
        ])('stays quiet when the latest release is %s', async (_label, tag) => {
            netFetch.mockResolvedValue(jsonResponse({ tag_name: tag }));
            await run();
            expect(showMessageBox).not.toHaveBeenCalled();
            expect(openExternal).not.toHaveBeenCalled();
        });

        it.each([
            ['an HTTP error (e.g. rate limit)', () => netFetch.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 403))],
            ['a network failure', () => netFetch.mockRejectedValue(new Error('ENOTFOUND api.github.com'))],
            ['a non-JSON body', () => netFetch.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
            ['a body without tag_name', () => netFetch.mockResolvedValue(jsonResponse({}))],
            ['a null body', () => netFetch.mockResolvedValue(jsonResponse(null))],
            ['a non-version tag', () => netFetch.mockResolvedValue(jsonResponse({ tag_name: 'nightly' }))],
        ])('logs and resolves without a dialog on %s', async (_label, arrange) => {
            arrange();
            await expect(run()).resolves.toBeUndefined();
            expect(showMessageBox).not.toHaveBeenCalled();
            expect(openExternal).not.toHaveBeenCalled();
            expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('skips the dialog when the window was closed before the check finished', async () => {
            netFetch.mockResolvedValue(jsonResponse({ tag_name: 'v0.14.0' }));
            await run(makeFakeWindow(true));
            expect(showMessageBox).not.toHaveBeenCalled();
        });

        it('swallows a failing openExternal', async () => {
            netFetch.mockResolvedValue(jsonResponse({ tag_name: 'v0.14.0' }));
            showMessageBox.mockResolvedValueOnce({ response: 0 });
            openExternal.mockRejectedValue(new Error('no browser'));
            await expect(run()).resolves.toBeUndefined();
            expect(consoleErrorSpy).toHaveBeenCalled();
        });
    });
});
