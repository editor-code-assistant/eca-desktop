import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

// ── Electron mock ────────────────────────────────────────────────
// `Menu.buildFromTemplate` records the template it was called with so
// each test can walk it and assert on structure.
const buildFromTemplate = vi.fn((template: unknown) => ({ _template: template }));
const setApplicationMenu = vi.fn();
const openExternal = vi.fn();
const showItemInFolder = vi.fn();

// Mutable `isPackaged` flag — menu.ts reads this (via `!app.isPackaged`)
// to decide whether to show dev-only affordances. Flipped per-test via
// `mockApp.isPackaged = true/false` below.
const mockApp = {
    name: 'ECA',
    getPath: () => '/tmp/fake-logs-should-not-be-used',
    isPackaged: true,
};

vi.mock('electron', () => ({
    app: mockApp,
    Menu: {
        buildFromTemplate,
        setApplicationMenu,
    },
    shell: {
        openExternal,
        showItemInFolder,
        openPath: vi.fn(async () => ''),
    },
    BrowserWindow: vi.fn(),
    dialog: {
        showMessageBox: vi.fn(),
        showSaveDialog: vi.fn(async () => ({ canceled: true })),
    },
}));

interface MenuItem {
    label?: string;
    accelerator?: string;
    role?: string;
    type?: string;
    submenu?: MenuItem[];
}

/** Flatten a menu template (and any nested submenus) into a single array. */
function walkItems(items: MenuItem[]): MenuItem[] {
    const flat: MenuItem[] = [];
    for (const item of items) {
        flat.push(item);
        if (item.submenu) flat.push(...walkItems(item.submenu));
    }
    return flat;
}

function makeFakeWindow() {
    // Minimum surface createMenu actually touches during template
    // construction (click handlers are never invoked in these tests).
    return {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
        close: vi.fn(),
    } as unknown as BrowserWindow;
}

describe('menu.ts — createMenu template', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        // Default to "packaged" (production) so dev-only items are hidden
        // unless a specific test opts in via `mockApp.isPackaged = false`.
        mockApp.isPackaged = true;
    });

    afterEach(() => {
        // Restore the default between suites so global state doesn't leak.
        mockApp.isPackaged = true;
    });

    async function loadAndBuild() {
        const { createMenu } = await import('../menu');
        createMenu(makeFakeWindow());
        expect(buildFromTemplate).toHaveBeenCalledTimes(1);
        const template = buildFromTemplate.mock.calls[0][0] as MenuItem[];
        return walkItems(template);
    }

    it('calls Menu.buildFromTemplate and Menu.setApplicationMenu', async () => {
        const { createMenu } = await import('../menu');
        createMenu(makeFakeWindow());
        expect(buildFromTemplate).toHaveBeenCalledTimes(1);
        expect(setApplicationMenu).toHaveBeenCalledTimes(1);
    });

    it('has no duplicate accelerators anywhere in the tree', async () => {
        const flat = await loadAndBuild();

        const accelerators = flat
            .map((i) => i.accelerator)
            .filter((a): a is string => typeof a === 'string' && a.length > 0);

        const seen = new Map<string, number>();
        for (const acc of accelerators) {
            seen.set(acc, (seen.get(acc) ?? 0) + 1);
        }
        const duplicates = [...seen.entries()].filter(([, n]) => n > 1);

        // Surface the offending key(s) in the failure message if any
        // duplicate sneaks back in (regression guard for the previously
        // flagged `CmdOrCtrl+B` collision).
        expect(duplicates, `Duplicate accelerators: ${JSON.stringify(duplicates)}`).toEqual([]);
    });

    it('omits toggleDevTools in packaged (production) builds', async () => {
        mockApp.isPackaged = true;
        const flat = await loadAndBuild();
        const devTools = flat.filter((i) => i.role === 'toggleDevTools');
        expect(devTools).toHaveLength(0);
    });

    it('includes toggleDevTools in unpackaged (dev) builds', async () => {
        mockApp.isPackaged = false;
        const flat = await loadAndBuild();
        const devTools = flat.filter((i) => i.role === 'toggleDevTools');
        expect(devTools.length).toBeGreaterThanOrEqual(1);
    });

    it('contains the expected top-level menus', async () => {
        const { createMenu } = await import('../menu');
        createMenu(makeFakeWindow());
        const template = buildFromTemplate.mock.calls[0][0] as MenuItem[];
        const labels = template.map((t) => t.label).filter(Boolean);
        // File/Edit/View/Chat/Window/Help are always present; app menu
        // (labelled `ECA`) only on macOS.
        expect(labels).toEqual(expect.arrayContaining([
            'File', 'Edit', 'View', 'Chat', 'Window', 'Help',
        ]));
    });
});
