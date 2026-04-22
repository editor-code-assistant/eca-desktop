// ============================================================
// Path-scope guard — ensures a candidate path resolves inside one
// of the configured workspace roots. Uses `fs.realpathSync` to
// defeat symlink-escape attacks, and falls back to `path.resolve`
// for paths that don't yet exist on disk.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve a path to its canonical absolute form. Tries `realpathSync`
 * first (follows symlinks); if that fails (e.g. ENOENT for a
 * not-yet-created file), falls back to `path.resolve`.
 */
function canonicalize(p: string): string {
    const absolute = path.resolve(p);
    try {
        return fs.realpathSync(absolute);
    } catch {
        return absolute;
    }
}

/**
 * Returns true if `candidate` resolves to a real path that is inside
 * one of `roots`. Both the candidate and each root are canonicalized
 * (realpath with fallback) before containment is tested.
 *
 * Containment rule: `path.relative(root, candidate)` must be either
 * the empty string (same path) or a path that does not start with
 * `..` and is not itself absolute.
 */
export function isWithinRoots(candidate: string, roots: string[]): boolean {
    if (!candidate || typeof candidate !== 'string') return false;
    if (!Array.isArray(roots) || roots.length === 0) return false;

    const resolvedCandidate = canonicalize(candidate);

    for (const root of roots) {
        if (!root || typeof root !== 'string') continue;
        const resolvedRoot = canonicalize(root);
        const relative = path.relative(resolvedRoot, resolvedCandidate);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
            return true;
        }
    }
    return false;
}

/**
 * Assert form of {@link isWithinRoots}. Throws a tagged error so
 * callers can match on `err.message === 'path-scope:out-of-bounds'`.
 */
export function assertWithinRoots(candidate: string, roots: string[]): void {
    if (!isWithinRoots(candidate, roots)) {
        throw new Error('path-scope:out-of-bounds');
    }
}
