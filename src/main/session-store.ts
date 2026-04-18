// ============================================================
// Session store — persists recent workspaces to disk
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from './constants';
import type { RecentWorkspace } from './protocol';

const MAX_RECENTS = 20;

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
        this.recentWorkspaces = this.recentWorkspaces.filter((w) => w.uri !== workspace.uri);
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
        this.recentWorkspaces = this.recentWorkspaces.filter((w) => w.uri !== uri);
        this.save();
    }
}
