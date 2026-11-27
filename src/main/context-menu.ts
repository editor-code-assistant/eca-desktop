// ============================================================
// Context menu — native right-click menu for every window
// ============================================================
//
// Electron shows no context menu by default, so right-clicking selected
// chat text or a text field did nothing: text could only be copied with
// the keyboard or the Edit menu. This builds the usual menu from what
// Chromium reports about the click (`context-menu` event params):
//
//   - text fields: Undo, Redo, Cut, Copy, Paste and Select All, each
//     enabled per Chromium's edit flags (so e.g. Cut/Copy stay disabled
//     in password fields)
//   - selected read-only text (chat messages, logs, …): Copy
//   - external links: Copy Link
//
// Anywhere else (nothing selected, not a text field) no menu is shown.
//
// Items call the right-clicked WebContents directly rather than using
// menu roles, which act on whichever window has focus when the item is
// clicked — not necessarily the one that was right-clicked.

import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';
import { BrowserWindow, clipboard, Menu } from 'electron';
import { sanitizeExternalUrl } from './security/url-allowlist';

/** The `context-menu` event params the menu is built from. */
export type ContextMenuInput = Pick<
    ContextMenuParams,
    'isEditable' | 'selectionText' | 'linkURL' | 'editFlags'
>;

/** The edit commands the menu runs on the right-clicked WebContents. */
export type EditTarget = Pick<WebContents, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'>;

/**
 * Builds the menu for one right-click. An empty template means there is
 * nothing to offer, and no menu should be shown.
 */
export function buildContextMenuTemplate(
    params: ContextMenuInput,
    target: EditTarget,
    platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
    const { editFlags } = params;
    const items: MenuItemConstructorOptions[] = [];
    const addGroup = (group: MenuItemConstructorOptions[]): void => {
        if (items.length > 0) items.push({ type: 'separator' });
        items.push(...group);
    };

    // Only links the app opens externally (see setWindowOpenHandler in
    // main.ts): in-app anchors such as `href="#"` resolve to the page's
    // own file:// URL, which is of no use to anyone.
    const link = params.linkURL ? sanitizeExternalUrl(params.linkURL) : null;
    if (link) {
        addGroup([{ label: 'Copy Link', click: () => clipboard.writeText(link) }]);
    }

    const copy: MenuItemConstructorOptions = {
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        enabled: editFlags.canCopy,
        click: () => target.copy(),
    };

    if (params.isEditable) {
        addGroup([
            {
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                enabled: editFlags.canUndo,
                click: () => target.undo(),
            },
            {
                label: 'Redo',
                // Same keys as the Edit menu's redo role.
                accelerator: platform === 'win32' ? 'Ctrl+Y' : 'Shift+CmdOrCtrl+Z',
                enabled: editFlags.canRedo,
                click: () => target.redo(),
            },
            { type: 'separator' },
            {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                enabled: editFlags.canCut,
                click: () => target.cut(),
            },
            copy,
            {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                enabled: editFlags.canPaste,
                click: () => target.paste(),
            },
            { type: 'separator' },
            {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                enabled: editFlags.canSelectAll,
                click: () => target.selectAll(),
            },
        ]);
    } else if (params.selectionText.trim().length > 0) {
        addGroup([copy]);
    }

    return items;
}

/** Shows the context menu on every right-click in `contents`. */
export function attachContextMenu(contents: WebContents): void {
    contents.on('context-menu', (_event, params) => {
        const template = buildContextMenuTemplate(params, contents);
        if (template.length === 0) return;
        Menu.buildFromTemplate(template).popup({
            window: BrowserWindow.fromWebContents(contents) ?? undefined,
            // Per Electron's docs, lets OS-level features such as macOS
            // Writing Tools work on the clicked frame.
            frame: params.frame ?? undefined,
            // Lets Windows/Linux adapt the menu to how it was opened
            // (mouse, keyboard, touch).
            sourceType: params.menuSourceType,
        });
    });
}
