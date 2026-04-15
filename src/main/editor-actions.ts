// ============================================================
// Editor actions — desktop-specific handlers (file, clipboard, URLs)
// ============================================================

import { BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MIME_TO_EXTENSION } from './constants';
import {
    EditorOpenFileData,
    EditorOpenUrlData,
    EditorSaveFileData,
    EditorSaveClipboardImageData,
    EditorSaveClipboardImageResult,
} from './protocol';

export function openFile(data: EditorOpenFileData): void {
    shell.openPath(data.path);
}

export function openUrl(data: EditorOpenUrlData): void {
    shell.openExternal(data.url);
}

export async function saveFile(mainWindow: BrowserWindow, data: EditorSaveFileData): Promise<void> {
    const defaultName = data.defaultName || 'chat-export.md';
    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(os.homedir(), defaultName),
        filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, data.content, 'utf-8');
    }
}

export function saveClipboardImage(data: EditorSaveClipboardImageData): EditorSaveClipboardImageResult | null {
    const { base64Data, mimeType, requestId } = data;
    const ext = MIME_TO_EXTENSION[mimeType] || 'png';
    const tmpPath = path.join(os.tmpdir(), `eca-screenshot-${Date.now()}.${ext}`);

    try {
        fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
        return { requestId, path: tmpPath };
    } catch (err) {
        console.error('[EditorActions] Failed to save clipboard image:', err);
        return null;
    }
}
