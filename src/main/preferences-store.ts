// ============================================================
// Preferences store — persists user preferences to disk
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './constants';

export interface Preferences {
    schemaVersion: 1;
    /** Absolute path to a user-provided ECA server binary. When set, the
     *  desktop app skips auto-download/version checks and uses this binary
     *  directly. When unset or empty, the managed binary under
     *  ~/.eca-desktop/ is used (auto-downloaded from GitHub releases). */
    serverBinaryPath?: string;
}

const DEFAULT_PREFERENCES: Preferences = {
    schemaVersion: 1,
};

export class PreferencesStore {
    private filePath: string;
    private preferences: Preferences = { ...DEFAULT_PREFERENCES };

    constructor() {
        this.filePath = path.join(getDataDir(), 'preferences.json');
        this.load();
    }

    load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const data = JSON.parse(raw);
            this.preferences = {
                ...DEFAULT_PREFERENCES,
                ...data,
                schemaVersion: 1,
            };
        } catch {
            // File may not exist yet, or contents are corrupt — keep defaults.
            this.preferences = { ...DEFAULT_PREFERENCES };
        }
    }

    save(): void {
        const data = JSON.stringify(this.preferences, null, 2);
        fs.writeFileSync(this.filePath, data, 'utf-8');
    }

    /** Defensive copy so callers cannot mutate internal state. */
    get(): Preferences {
        return { ...this.preferences };
    }

    /** Merge a partial patch, normalize, persist, and return the new state. */
    set(patch: Partial<Preferences>): Preferences {
        const merged: Preferences = {
            ...this.preferences,
            ...patch,
            schemaVersion: 1,
        };

        // Normalize: empty / whitespace-only server path -> unset.
        if (merged.serverBinaryPath !== undefined) {
            const trimmed = merged.serverBinaryPath.trim();
            if (trimmed === '') {
                delete merged.serverBinaryPath;
            } else {
                merged.serverBinaryPath = trimmed;
            }
        }

        this.preferences = merged;
        this.save();
        return this.get();
    }

    clearServerBinaryPath(): Preferences {
        const next: Preferences = { schemaVersion: 1 };
        // Preserve any other future fields (none today).
        for (const [key, value] of Object.entries(this.preferences)) {
            if (key === 'serverBinaryPath' || key === 'schemaVersion') continue;
            (next as any)[key] = value;
        }
        this.preferences = next;
        this.save();
        return this.get();
    }
}
