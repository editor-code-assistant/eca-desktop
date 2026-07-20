import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { on: vi.fn() },
    ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
    BrowserWindow: vi.fn(),
}));

import { sanitizeInputDialogOptions } from '../input-dialog';

describe('sanitizeInputDialogOptions', () => {
    it('applies defaults for an empty payload', () => {
        expect(sanitizeInputDialogOptions({})).toEqual({
            title: 'Input required',
            placeholder: '',
            options: [],
            password: false,
        });
    });

    it('passes through a well-formed ProvidersTab payload', () => {
        expect(
            sanitizeInputDialogOptions({
                title: 'Choose login method',
                placeholder: 'Select a method...',
                options: ['OAuth', 'API Key'],
            }),
        ).toEqual({
            title: 'Choose login method',
            placeholder: 'Select a method...',
            options: ['OAuth', 'API Key'],
            password: false,
        });
    });

    it('drops non-string options instead of stringifying them', () => {
        const config = sanitizeInputDialogOptions({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            options: ['ok', 42, { evil: true }, null, 'also ok'] as any,
        });
        expect(config.options).toEqual(['ok', 'also ok']);
    });

    it('caps option-list length and clips long strings', () => {
        const config = sanitizeInputDialogOptions({
            title: 'x'.repeat(1000),
            options: Array.from({ length: 100 }, (_, i) => `opt-${i}`),
        });
        expect(config.title).toHaveLength(200);
        expect(config.options).toHaveLength(20);
    });

    it('only treats password === true as truthy', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(sanitizeInputDialogOptions({ password: 'yes' as any }).password).toBe(false);
        expect(sanitizeInputDialogOptions({ password: true }).password).toBe(true);
    });
});
