import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron (transitive import chain compatibility).
vi.mock('electron', () => ({
    BrowserWindow: vi.fn(),
}));

// Redirect getDataDir to a temp directory per test so we never touch
// the real ~/.eca-desktop/ folder.
let tmpDir: string;
vi.mock('../constants', async () => {
    const actual = await vi.importActual<typeof import('../constants')>('../constants');
    return {
        ...actual,
        getDataDir: () => tmpDir,
    };
});

import { PreferencesStore } from '../preferences-store';

describe('PreferencesStore', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-prefs-test-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    it('returns defaults when no file exists', () => {
        const store = new PreferencesStore();
        expect(store.get()).toEqual({ schemaVersion: 1 });
    });

    it('persists and reloads serverBinaryPath', () => {
        const store = new PreferencesStore();
        store.set({ serverBinaryPath: '/usr/local/bin/eca' });

        const fresh = new PreferencesStore();
        expect(fresh.get()).toEqual({
            schemaVersion: 1,
            serverBinaryPath: '/usr/local/bin/eca',
        });
    });

    it('normalizes empty string to unset', () => {
        const store = new PreferencesStore();
        store.set({ serverBinaryPath: '/tmp/eca' });
        store.set({ serverBinaryPath: '' });
        expect(store.get()).toEqual({ schemaVersion: 1 });
    });

    it('trims whitespace from serverBinaryPath', () => {
        const store = new PreferencesStore();
        store.set({ serverBinaryPath: '  /usr/local/bin/eca  ' });
        expect(store.get().serverBinaryPath).toBe('/usr/local/bin/eca');
    });

    it('clearServerBinaryPath removes the field', () => {
        const store = new PreferencesStore();
        store.set({ serverBinaryPath: '/tmp/eca' });
        store.clearServerBinaryPath();
        expect(store.get()).toEqual({ schemaVersion: 1 });
    });

    it('forces schemaVersion to 1 on set', () => {
        const store = new PreferencesStore();
        // @ts-expect-error — testing tolerance to a stray field
        store.set({ schemaVersion: 99, serverBinaryPath: '/x' });
        expect(store.get().schemaVersion).toBe(1);
    });

    it('get() returns a defensive copy', () => {
        const store = new PreferencesStore();
        store.set({ serverBinaryPath: '/tmp/eca' });
        const snapshot = store.get();
        snapshot.serverBinaryPath = '/mutated';
        expect(store.get().serverBinaryPath).toBe('/tmp/eca');
    });

    it('ignores a corrupt file and keeps defaults', () => {
        fs.writeFileSync(path.join(tmpDir, 'preferences.json'), 'not json', 'utf-8');
        const store = new PreferencesStore();
        expect(store.get()).toEqual({ schemaVersion: 1 });
    });
});
