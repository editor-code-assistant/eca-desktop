// ============================================================
// Session store — persists recent workspaces to disk
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getDataDir } from './constants';
import type { RecentWorkspace } from './protocol';

const MAX_RECENTS = 20;

/**
 * Compare two workspace file:// URIs for identity. Windows filesystems
 * are case-insensitive and drive-letter casing can vary between sources
 * (open dialog vs recents round-trip), so compare case-insensitively
 * there; elsewhere paths are case-sensitive and compared verbatim.
 */
export function sameWorkspaceUri(a: string, b: string): boolean {
    if (process.platform === 'win32') {
        return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
}

/**
 * Human-friendly path for a workspace file:// URI: native separators,
 * percent-decoded, home directory shortened to `~` on POSIX platforms.
 * Falls back to the raw string when it isn't a parseable file URL.
 */
export function workspaceDisplayPath(uri: string): string {
    let p: string;
    try {
        p = fileURLToPath(uri);
    } catch {
        return uri;
    }
    if (process.platform === 'win32') return p;
    const home = os.homedir();
    if (p === home || p.startsWith(home + path.sep)) {
        return '~' + p.slice(home.length);
    }
    return p;
}

export class SessionStore {
    private filePath: string;
    private recentWorkspaces: RecentWorkspace[] = [];

    constructor() {
        this.filePath = path.join(getDataDir(), 'sessions.json');
        this.load();
    }

    load(): void {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.recentWorkspaces)) {
                this.recentWorkspaces = data.recentWorkspaces;
            }
        } catch {
            // File may not exist yet — that's fine
        }
    }

    save(): void {
        const data = JSON.stringify({ recentWorkspaces: this.recentWorkspaces }, null, 2);
        fs.writeFileSync(this.filePath, data, 'utf-8');
    }

    getRecents(): RecentWorkspace[] {
        return [...this.recentWorkspaces];
    }

    addRecent(workspace: { uri: string; name: string }): void {
        this.recentWorkspaces = this.recentWorkspaces.filter((w) => !sameWorkspaceUri(w.uri, workspace.uri));
        this.recentWorkspaces.unshift({
            uri: workspace.uri,
            name: workspace.name,
            lastOpened: Date.now(),
        });
        if (this.recentWorkspaces.length > MAX_RECENTS) {
            this.recentWorkspaces = this.recentWorkspaces.slice(0, MAX_RECENTS);
        }
        this.save();
    }

    removeRecent(uri: string): void {
        this.recentWorkspaces = this.recentWorkspaces.filter((w) => !sameWorkspaceUri(w.uri, uri));
        this.save();
    }
}
