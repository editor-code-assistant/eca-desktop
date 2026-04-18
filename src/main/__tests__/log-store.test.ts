import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron — `LogStore` only touches `require('electron')` from its
// singleton factory; constructing it directly with an explicit `logDir`
// does not. Still, a transitive import elsewhere could pull the real
// module, so stub it defensively.
vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/fake-logs-should-not-be-used',
    },
}));

import { LogStore, inferLevel } from '../log-store';

describe('inferLevel', () => {
    it('flags ERROR/FATAL/Exception/Traceback as error', () => {
        expect(inferLevel('something ERROR happened')).toBe('error');
        expect(inferLevel('FATAL: crash')).toBe('error');
        expect(inferLevel('RuntimeException: boom')).toBe('error');
        expect(inferLevel('Traceback (most recent call last):')).toBe('error');
    });

    it('flags non-zero exit codes as error', () => {
        expect(inferLevel('ECA server process exited with code 1')).toBe('error');
        expect(inferLevel('ECA server process exited with code 137')).toBe('error');
    });

    it('does NOT flag exit code 0 as error', () => {
        expect(inferLevel('ECA server process exited with code 0')).toBe('info');
    });

    it('flags "Failed to …" as error', () => {
        expect(inferLevel('Failed to start ECA server: ENOENT')).toBe('error');
    });

    it('defaults to info for ordinary lines', () => {
        expect(inferLevel('Starting ECA server: /usr/local/bin/eca')).toBe('info');
        expect(inferLevel('ECA server initialized')).toBe('info');
    });
});

describe('LogStore (in-memory mode)', () => {
    let store: LogStore;

    beforeEach(() => {
        store = new LogStore({ maxEntries: 5 });
    });

    it('starts with an empty snapshot', () => {
        expect(store.snapshot()).toEqual([]);
    });

    it('appends entries and returns a populated snapshot', () => {
        store.append({ source: 'server', text: 'hello' });
        store.append({ source: 'server', text: 'world' });
        const snap = store.snapshot();
        expect(snap).toHaveLength(2);
        expect(snap[0].text).toBe('hello');
        expect(snap[1].text).toBe('world');
    });

    it('auto-assigns ts, seq, and level when omitted', () => {
        const before = Date.now();
        const e = store.append({ source: 'server', text: 'plain info' });
        const after = Date.now();

        expect(e.ts).toBeGreaterThanOrEqual(before);
        expect(e.ts).toBeLessThanOrEqual(after);
        expect(e.seq).toBe(1);
        expect(e.level).toBe('info');
    });

    it('increments seq monotonically', () => {
        const a = store.append({ source: 'server', text: 'a' });
        const b = store.append({ source: 'server', text: 'b' });
        const c = store.append({ source: 'server', text: 'c' });
        expect(a.seq).toBe(1);
        expect(b.seq).toBe(2);
        expect(c.seq).toBe(3);
    });

    it('trims to maxEntries (ring buffer)', () => {
        for (let i = 0; i < 8; i++) {
            store.append({ source: 'server', text: `line ${i}` });
        }
        const snap = store.snapshot();
        expect(snap).toHaveLength(5);
        // Oldest retained should be line 3 (0,1,2 dropped).
        expect(snap[0].text).toBe('line 3');
        expect(snap[4].text).toBe('line 7');
    });

    it('infers level from text when not explicit', () => {
        const ok = store.append({ source: 'server', text: 'ECA up' });
        const bad = store.append({ source: 'server', text: 'ERROR boom' });
        expect(ok.level).toBe('info');
        expect(bad.level).toBe('error');
    });

    it('respects explicit level over inference', () => {
        const e = store.append({ source: 'server', text: 'ERROR in text', level: 'info' });
        expect(e.level).toBe('info');
    });

    it('fans out to subscribers', () => {
        const fn = vi.fn();
        store.subscribe(fn);
        store.append({ source: 'server', text: 'x' });
        expect(fn).toHaveBeenCalledOnce();
        expect(fn.mock.calls[0][0].text).toBe('x');
    });

    it('unsubscribe stops further notifications', () => {
        const fn = vi.fn();
        const off = store.subscribe(fn);
        store.append({ source: 'server', text: 'a' });
        off();
        store.append({ source: 'server', text: 'b' });
        expect(fn).toHaveBeenCalledOnce();
    });

    it('does not let a throwing subscriber break the others', () => {
        const good = vi.fn();
        store.subscribe(() => { throw new Error('nope'); });
        store.subscribe(good);
        expect(() => store.append({ source: 'server', text: 'x' })).not.toThrow();
        expect(good).toHaveBeenCalledOnce();
    });

    it('clear() empties the ring buffer but keeps the sequence counter', () => {
        store.append({ source: 'server', text: 'a' });
        store.append({ source: 'server', text: 'b' });
        store.clear();
        expect(store.snapshot()).toEqual([]);
        const next = store.append({ source: 'server', text: 'c' });
        expect(next.seq).toBe(3); // seq keeps counting after clear
    });

    it('snapshot returns a copy, not the internal array', () => {
        store.append({ source: 'server', text: 'a' });
        const snap = store.snapshot();
        snap.push({ ts: 0, seq: 99, source: 'server', level: 'info', text: 'mutated' });
        expect(store.snapshot()).toHaveLength(1);
    });

    it('logFilePath() and logFolderPath() are null without logDir', () => {
        expect(store.logFilePath()).toBeNull();
        expect(store.logFolderPath()).toBeNull();
    });
});

describe('LogStore (file sink)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eca-logstore-test-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('creates the log directory and writes entries', () => {
        const store = new LogStore({ logDir: tmpDir });
        store.append({ source: 'server', text: 'first line' });
        store.append({ source: 'server', text: 'second line' });

        const content = fs.readFileSync(path.join(tmpDir, 'eca-server.log'), 'utf-8');
        expect(content).toContain('first line');
        expect(content).toContain('second line');
        expect(content.split('\n').filter(Boolean)).toHaveLength(2);
    });

    it('rotates when the file exceeds maxFileSize', () => {
        const store = new LogStore({
            logDir: tmpDir,
            maxFileSize: 200,   // very small so a couple of lines triggers rotation
            maxRotations: 2,
        });

        // Write enough to exceed the threshold twice over.
        for (let i = 0; i < 20; i++) {
            store.append({ source: 'server', text: `line-${i}-${'x'.repeat(40)}` });
        }

        const files = fs.readdirSync(tmpDir).sort();
        expect(files).toContain('eca-server.log');
        // At least one rotated copy must exist.
        expect(files.some(f => /^eca-server\.log\.\d+$/.test(f))).toBe(true);
    });

    it('logFilePath() and logFolderPath() reflect the configured paths', () => {
        const store = new LogStore({ logDir: tmpDir, fileName: 'custom.log' });
        expect(store.logFolderPath()).toBe(tmpDir);
        expect(store.logFilePath()).toBe(path.join(tmpDir, 'custom.log'));
    });

    it('clear() does not remove the on-disk log file', () => {
        const store = new LogStore({ logDir: tmpDir });
        store.append({ source: 'server', text: 'persisted' });
        store.clear();
        const content = fs.readFileSync(path.join(tmpDir, 'eca-server.log'), 'utf-8');
        expect(content).toContain('persisted');
    });
});
