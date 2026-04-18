// ============================================================
// LogStore — central in-memory ring buffer + rotating file sink
// for ECA server stderr and lifecycle messages.
//
// Why this exists:
//   - `EcaServer.stderr` is captured at src/main/server.ts and funnelled
//     through `onLog`. Previously that just did `console.log`, which is
//     lost in a packaged Electron app. This store fans out each line to
//     three sinks — a capped in-memory buffer, a rotating log file under
//     Electron's per-app `logs` path, and live IPC subscribers — so the
//     desktop UI and bug-report attachments both have a usable trail.
//
// Usage:
//   - Production: `getLogStore()` returns a singleton whose file sink
//     points at `app.getPath('logs')/eca-server.log`. Must be called
//     AFTER `app.whenReady()` because Electron only resolves
//     `getPath('logs')` once the app is ready.
//   - Tests: construct `new LogStore({ logDir })` directly with a temp
//     directory. The singleton can be reset via `__setLogStoreForTests`.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

export type LogSource = 'server' | 'desktop';
export type LogLevel = 'info' | 'error';

export interface LogEntry {
    /** Unix epoch ms when the entry was created. */
    ts: number;
    /** Sequential id within the process lifetime — makes entries stably sortable. */
    seq: number;
    /** Which session emitted the entry, if any. Desktop-origin entries have no sessionId. */
    sessionId?: string;
    /** Origin of the entry. */
    source: LogSource;
    /** Inferred or explicit level. */
    level: LogLevel;
    /** Raw text (may be multi-line). */
    text: string;
}

export interface LogStoreOptions {
    /** Directory where the log file lives. When omitted, nothing is written to disk. */
    logDir?: string;
    /** File name inside `logDir`. Default: `eca-server.log`. */
    fileName?: string;
    /** Max entries kept in the in-memory ring buffer. Default: 5000. */
    maxEntries?: number;
    /** Rotation threshold in bytes. Default: 5 MB. */
    maxFileSize?: number;
    /** How many rotated copies to keep (`.1`, `.2`, …). Default: 3. */
    maxRotations?: number;
}

/** Simple heuristic for tagging a line as an error. Conservative — we'd
 * rather under-flag than spam the error badge.
 *
 * Note: `Exception` intentionally has no leading `\b` so the regex also
 * flags Java-style class names like `RuntimeException` (the preceding
 * character is usually a word-character, which defeats `\b`). */
export function inferLevel(text: string): LogLevel {
    if (/\bERROR\b|\bFATAL\b|\bTraceback\b|Exception\b/.test(text)) return 'error';
    if (/exited with code (?!0\b)/.test(text)) return 'error';
    if (/\bFailed to\b/i.test(text)) return 'error';
    return 'info';
}

type Subscriber = (entry: LogEntry) => void;

export class LogStore {
    private entries: LogEntry[] = [];
    private readonly subscribers = new Set<Subscriber>();
    private nextSeq = 1;

    private readonly maxEntries: number;
    private readonly maxFileSize: number;
    private readonly maxRotations: number;
    private readonly logDir: string | null;
    private readonly logFile: string | null;

    constructor(options: LogStoreOptions = {}) {
        this.maxEntries = options.maxEntries ?? 5000;
        this.maxFileSize = options.maxFileSize ?? 5 * 1024 * 1024;
        this.maxRotations = options.maxRotations ?? 3;

        const fileName = options.fileName ?? 'eca-server.log';
        this.logDir = options.logDir ?? null;
        this.logFile = this.logDir ? path.join(this.logDir, fileName) : null;

        if (this.logDir) {
            try {
                fs.mkdirSync(this.logDir, { recursive: true });
            } catch {
                // If we can't create the log dir, degrade to in-memory only.
            }
        }
    }

    /** Immutable snapshot of the current ring buffer, oldest first. */
    snapshot(): LogEntry[] {
        return this.entries.slice();
    }

    /** Absolute path to the log file, or `null` when running in memory-only mode. */
    logFilePath(): string | null {
        return this.logFile;
    }

    /** Absolute path to the log directory, or `null` when running in memory-only mode. */
    logFolderPath(): string | null {
        return this.logDir;
    }

    /** Drop all in-memory entries. Does NOT touch the file — rotating/erasing
     * the log file could lose diagnostic info the user needs for bug reports. */
    clear(): void {
        this.entries = [];
    }

    /** Register a listener for each new entry. Returns an unsubscribe fn. */
    subscribe(fn: Subscriber): () => void {
        this.subscribers.add(fn);
        return () => {
            this.subscribers.delete(fn);
        };
    }

    /** Append a new entry. `ts`, `seq` and `level` default if omitted. */
    append(partial: Omit<LogEntry, 'ts' | 'seq' | 'level'> & {
        ts?: number;
        level?: LogLevel;
    }): LogEntry {
        const entry: LogEntry = {
            ts: partial.ts ?? Date.now(),
            seq: this.nextSeq++,
            sessionId: partial.sessionId,
            source: partial.source,
            level: partial.level ?? inferLevel(partial.text),
            text: partial.text,
        };

        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            // Trim from the front — cheapest correct operation for a
            // soft-cap ring; at steady state we drop one per append.
            this.entries.splice(0, this.entries.length - this.maxEntries);
        }

        this.writeToFile(entry);

        for (const sub of this.subscribers) {
            try {
                sub(entry);
            } catch {
                // A broken subscriber must not poison the others.
            }
        }

        return entry;
    }

    // ── File sink ──

    private formatForFile(entry: LogEntry): string {
        const ts = new Date(entry.ts).toISOString();
        const session = entry.sessionId ? ` [${entry.sessionId.slice(0, 8)}]` : '';
        const level = entry.level === 'error' ? 'ERROR' : 'INFO ';
        return `${ts} ${level} ${entry.source}${session} ${entry.text}\n`;
    }

    private writeToFile(entry: LogEntry): void {
        if (!this.logFile) return;

        try {
            this.rotateIfNeeded();
            fs.appendFileSync(this.logFile, this.formatForFile(entry), 'utf-8');
        } catch {
            // File I/O errors must not take down the store; subscribers
            // and the ring buffer remain unaffected.
        }
    }

    private rotateIfNeeded(): void {
        if (!this.logFile) return;

        let size = 0;
        try {
            size = fs.statSync(this.logFile).size;
        } catch {
            return; // file doesn't exist yet — nothing to rotate.
        }

        if (size < this.maxFileSize) return;

        // Rotate: .{N-1} -> .{N}, ..., log -> .1, and drop anything at .{maxRotations}.
        for (let i = this.maxRotations; i >= 1; i--) {
            const src = i === 1 ? this.logFile : `${this.logFile}.${i - 1}`;
            const dst = `${this.logFile}.${i}`;
            if (i === this.maxRotations) {
                try { fs.unlinkSync(dst); } catch {/* ok if missing */}
            }
            try { fs.renameSync(src, dst); } catch {/* ok if missing */}
        }
    }
}

// ── Singleton ──
//
// We keep the instance private so tests can reset it without relying on
// module caching quirks; production callers should use `getLogStore()`.

let _instance: LogStore | null = null;

/** Lazily construct the singleton, pointing its file sink at Electron's
 * per-app logs path. Must be called after `app.whenReady()`. */
export function getLogStore(): LogStore {
    if (_instance) return _instance;

    // Defer the `electron` import so this module can still be imported
    // (and `LogStore` constructed directly) in a unit-test process where
    // `electron` is mocked / unavailable.
    const { app } = require('electron');
    _instance = new LogStore({ logDir: app.getPath('logs') });
    return _instance;
}

/** Test-only: override the singleton (or clear it with `null`). */
export function __setLogStoreForTests(store: LogStore | null): void {
    _instance = store;
}
