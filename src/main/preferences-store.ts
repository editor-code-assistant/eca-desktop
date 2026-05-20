// ============================================================
// Preferences store — persists user preferences to disk
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './constants';

/** Visual theme for the desktop shell. When the field is absent, the
 *  renderer falls back to 'dark' (the historical default) so existing
 *  users see no change until they explicitly pick Light. */
export type Theme = 'light' | 'dark';

export const VALID_THEMES: ReadonlyArray<Theme> = ['light', 'dark'];

export function isValidTheme(value: unknown): value is Theme {
    return typeof value === 'string' && (VALID_THEMES as readonly string[]).includes(value);
}

export interface Preferences {
    schemaVersion: 1;
    /** Absolute path to a user-provided ECA server binary. When set, the
     *  desktop app skips auto-download/version checks and uses this binary
     *  directly. When unset or empty, the managed binary under
     *  ~/.eca-desktop/ is used (auto-downloaded from GitHub releases). */
    serverBinaryPath?: string;
    /** UI theme for the desktop shell (Preferences window, sidebar,
     *  welcome screen, and embedded chat webview via --eca-* overrides).
     *  When unset, the renderer defaults to 'dark'. */
    theme?: Theme;
    /** Whether the sidebar is collapsed to an icon rail (48px) instead of
     *  the full 260px width. When unset, defaults to `false` (expanded). */
    sidebarCollapsed?: boolean;
    /** Whether to resolve the user's login+interactive shell env (PATH,
     *  HOMEBREW_PREFIX, NVM_DIR, ...) before spawning the ECA server.
     *  Mitigates the macOS/Linux "GUI app launched from Finder/launchctl
     *  doesn't inherit dotfile PATH" problem. No-op on Windows. When
     *  unset, defaults to `true`. */
    resolveShellEnv?: boolean;
    /** Maximum wall-clock time in milliseconds for the shell to print
     *  its env. Clamped to `[1_000, 120_000]` on set. When unset,
     *  defaults to `10_000`. */
    shellEnvResolutionTimeoutMs?: number;
}

const SHELL_ENV_TIMEOUT_MIN_MS = 1_000;
const SHELL_ENV_TIMEOUT_MAX_MS = 120_000;

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

        // Normalize: invalid theme values -> unset (renderer falls back to 'dark').
        if (merged.theme !== undefined && !isValidTheme(merged.theme)) {
            delete merged.theme;
        }

        // Normalize the shell-env timeout. Non-numeric / non-finite values
        // are dropped (renderer falls back to the default); finite values
        // are clamped into the supported range so a typo can't disable
        // the resolver outright or wedge it for two minutes.
        if (merged.shellEnvResolutionTimeoutMs !== undefined) {
            const t = merged.shellEnvResolutionTimeoutMs;
            if (typeof t !== 'number' || !Number.isFinite(t)) {
                delete merged.shellEnvResolutionTimeoutMs;
            } else {
                merged.shellEnvResolutionTimeoutMs = Math.min(
                    SHELL_ENV_TIMEOUT_MAX_MS,
                    Math.max(SHELL_ENV_TIMEOUT_MIN_MS, Math.floor(t)),
                );
            }
        }

        this.preferences = merged;
        this.save();
        return this.get();
    }

    clearServerBinaryPath(): Preferences {
        const next: Preferences = { schemaVersion: 1 };
        // Preserve any other future fields (none today). We widen to an
        // indexed record just for this copy step — `Preferences` is a
        // sealed shape, but when a newer schema version adds fields we
        // want to carry them through unchanged.
        const sink = next as Preferences & Record<string, unknown>;
        for (const [key, value] of Object.entries(this.preferences)) {
            if (key === 'serverBinaryPath' || key === 'schemaVersion') continue;
            sink[key] = value;
        }
        this.preferences = next;
        this.save();
        return this.get();
    }
}
