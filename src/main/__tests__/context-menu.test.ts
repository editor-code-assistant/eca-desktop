import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextMenuParams, EditFlags, MenuItemConstructorOptions, WebContents } from 'electron';

const mocks = vi.hoisted(() => ({
    writeText: vi.fn(),
    popup: vi.fn(),
    buildFromTemplate: vi.fn(),
    fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
    BrowserWindow: { fromWebContents: mocks.fromWebContents },
    clipboard: { writeText: mocks.writeText },
    Menu: { buildFromTemplate: mocks.buildFromTemplate },
}));

import type { ContextMenuInput } from '../context-menu';
import { attachContextMenu, buildContextMenuTemplate } from '../context-menu';

const NO_EDIT: EditFlags = {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
};

function params(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
    return { isEditable: false, selectionText: '', linkURL: '', editFlags: NO_EDIT, ...overrides };
}

function makeTarget() {
    return {
        undo: vi.fn(),
        redo: vi.fn(),
        cut: vi.fn(),
        copy: vi.fn(),
        paste: vi.fn(),
        selectAll: vi.fn(),
    };
}

/** Item labels, separators as '---', to assert on the menu at a glance. */
function labels(template: MenuItemConstructorOptions[]): string[] {
    return template.map((i) => (i.type === 'separator' ? '---' : i.label ?? ''));
}

function itemNamed(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
    const item = template.find((i) => i.label === label);
    if (!item) throw new Error(`No "${label}" item in [${labels(template).join(', ')}]`);
    return item;
}

/** Runs an item's click handler (ours ignore Electron's arguments). */
function click(template: MenuItemConstructorOptions[], label: string): void {
    (itemNamed(template, label).click as unknown as () => void)();
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('buildContextMenuTemplate', () => {
    it('offers Copy for selected read-only text, copying from the clicked page', () => {
        const target = makeTarget();
        const template = buildContextMenuTemplate(
            params({ selectionText: 'some answer', editFlags: { ...NO_EDIT, canCopy: true } }),
            target,
        );

        expect(labels(template)).toEqual(['Copy']);
        expect(itemNamed(template, 'Copy').enabled).toBe(true);

        click(template, 'Copy');
        expect(target.copy).toHaveBeenCalledTimes(1);
    });

    it('offers nothing when no text is selected outside a text field', () => {
        expect(buildContextMenuTemplate(params(), makeTarget())).toEqual([]);
        expect(buildContextMenuTemplate(params({ selectionText: ' \n\t ' }), makeTarget())).toEqual([]);
    });

    it('offers the edit menu in text fields, even empty ones, enabled per edit flags', () => {
        const template = buildContextMenuTemplate(
            params({
                isEditable: true,
                editFlags: { ...NO_EDIT, canUndo: true, canPaste: true, canSelectAll: true },
            }),
            makeTarget(),
        );

        expect(labels(template)).toEqual([
            'Undo', 'Redo', '---', 'Cut', 'Copy', 'Paste', '---', 'Select All',
        ]);
        const enabled = Object.fromEntries(
            template.filter((i) => i.label).map((i) => [i.label, i.enabled]),
        );
        expect(enabled).toEqual({
            'Undo': true,
            'Redo': false,
            'Cut': false,
            'Copy': false,
            'Paste': true,
            'Select All': true,
        });
    });

    it('keeps Cut and Copy disabled where Chromium forbids them, e.g. password fields', () => {
        const template = buildContextMenuTemplate(
            params({
                isEditable: true,
                selectionText: 'sk-secret',
                editFlags: { ...NO_EDIT, canPaste: true, canSelectAll: true },
            }),
            makeTarget(),
        );

        expect(itemNamed(template, 'Cut').enabled).toBe(false);
        expect(itemNamed(template, 'Copy').enabled).toBe(false);
        expect(itemNamed(template, 'Paste').enabled).toBe(true);
    });

    it('runs each edit command on the clicked page', () => {
        const target = makeTarget();
        const template = buildContextMenuTemplate(params({ isEditable: true }), target);

        const commands = [
            ['Undo', target.undo],
            ['Redo', target.redo],
            ['Cut', target.cut],
            ['Copy', target.copy],
            ['Paste', target.paste],
            ['Select All', target.selectAll],
        ] as const;
        for (const [label, command] of commands) {
            click(template, label);
            expect(command, label).toHaveBeenCalledTimes(1);
        }
    });

    it('shows the same redo shortcut as the Edit menu on each platform', () => {
        const redoKeys = (platform: NodeJS.Platform) => itemNamed(
            buildContextMenuTemplate(params({ isEditable: true }), makeTarget(), platform),
            'Redo',
        ).accelerator;

        expect(redoKeys('win32')).toBe('Ctrl+Y');
        expect(redoKeys('darwin')).toBe('Shift+CmdOrCtrl+Z');
        expect(redoKeys('linux')).toBe('Shift+CmdOrCtrl+Z');
    });

    it('offers Copy Link on external links, copying the URL without credentials', () => {
        const template = buildContextMenuTemplate(
            params({ linkURL: 'https://user:pass@eca.dev/config' }),
            makeTarget(),
        );

        expect(labels(template)).toEqual(['Copy Link']);
        click(template, 'Copy Link');
        expect(mocks.writeText).toHaveBeenCalledWith('https://eca.dev/config');

        expect(labels(buildContextMenuTemplate(
            params({ linkURL: 'mailto:someone@example.com' }),
            makeTarget(),
        ))).toEqual(['Copy Link']);
    });

    it('offers no Copy Link on in-app or non-web links', () => {
        // `<a href="#" onClick>` resolves to the page's own file:// URL.
        for (const linkURL of ['file:///opt/ECA/src/renderer/index.html#', 'javascript:alert(1)']) {
            expect(buildContextMenuTemplate(params({ linkURL }), makeTarget()), linkURL).toEqual([]);
        }
    });

    it('separates Copy Link from Copy when right-clicking selected link text', () => {
        const template = buildContextMenuTemplate(
            params({
                linkURL: 'https://eca.dev/',
                selectionText: 'eca.dev',
                editFlags: { ...NO_EDIT, canCopy: true },
            }),
            makeTarget(),
        );

        expect(labels(template)).toEqual(['Copy Link', '---', 'Copy']);
    });
});

describe('attachContextMenu', () => {
    function attach() {
        const contents = { ...makeTarget(), on: vi.fn() };
        attachContextMenu(contents as unknown as WebContents);
        expect(contents.on).toHaveBeenCalledWith('context-menu', expect.any(Function));
        const onContextMenu = contents.on.mock.calls[0][1] as (event: unknown, params: ContextMenuParams) => void;
        const rightClick = (input: ContextMenuInput, extra: Partial<ContextMenuParams> = {}) =>
            onContextMenu({}, { frame: null, menuSourceType: 'mouse', ...input, ...extra } as ContextMenuParams);
        return { contents, rightClick };
    }

    beforeEach(() => {
        mocks.buildFromTemplate.mockImplementation((template: MenuItemConstructorOptions[]) => ({
            template,
            popup: mocks.popup,
        }));
    });

    it('pops the menu up over the clicked window and frame, acting on its page', () => {
        const window = { id: 7 };
        const frame = { routingId: 3 };
        mocks.fromWebContents.mockReturnValue(window);
        const { contents, rightClick } = attach();

        rightClick(
            params({ selectionText: 'some answer', editFlags: { ...NO_EDIT, canCopy: true } }),
            { frame: frame as unknown as ContextMenuParams['frame'], menuSourceType: 'keyboard' },
        );

        expect(mocks.fromWebContents).toHaveBeenCalledWith(contents);
        expect(mocks.popup).toHaveBeenCalledWith({ window, frame, sourceType: 'keyboard' });

        const template = mocks.buildFromTemplate.mock.calls[0][0] as MenuItemConstructorOptions[];
        click(template, 'Copy');
        expect(contents.copy).toHaveBeenCalledTimes(1);
    });

    it('still pops up when the window or frame is already gone', () => {
        mocks.fromWebContents.mockReturnValue(null);
        const { rightClick } = attach();

        rightClick(params({ isEditable: true }));

        expect(mocks.popup).toHaveBeenCalledWith({ window: undefined, frame: undefined, sourceType: 'mouse' });
    });

    it('shows no menu when the click offers nothing', () => {
        const { rightClick } = attach();

        rightClick(params());

        expect(mocks.buildFromTemplate).not.toHaveBeenCalled();
        expect(mocks.popup).not.toHaveBeenCalled();
    });
});
