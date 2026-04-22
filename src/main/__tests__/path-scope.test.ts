import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isWithinRoots, assertWithinRoots } from '../security/path-scope';

// Canonicalize the tmp dir once so roots already match realpath's view.
// On macOS `/tmp` is a symlink to `/private/tmp`; using the realpath avoids
// mismatches when the candidate is a real (existing) subdirectory.
const TMP = fs.realpathSync(os.tmpdir());

describe('isWithinRoots', () => {
    describe('basic containment', () => {
        it('returns true for a nested file inside the root', () => {
            // These paths don't exist on disk → realpath falls back to
            // path.resolve for both root and candidate.
            expect(
                isWithinRoots('/home/user/project/src/main.ts', ['/home/user/project']),
            ).toBe(true);
        });

        it('returns true when candidate equals root', () => {
            expect(
                isWithinRoots('/home/user/project', ['/home/user/project']),
            ).toBe(true);
        });

        it('treats trailing-slash variants as equal', () => {
            expect(
                isWithinRoots('/home/user/project/', ['/home/user/project']),
            ).toBe(true);
            expect(
                isWithinRoots('/home/user/project', ['/home/user/project/']),
            ).toBe(true);
        });
    });

    describe('rejected paths', () => {
        it('rejects a sibling directory', () => {
            expect(
                isWithinRoots('/home/user/other', ['/home/user/project']),
            ).toBe(false);
        });

        it('rejects parent traversal even if the string is inside the root', () => {
            // Normalizes to /home/user/other, which is a sibling.
            expect(
                isWithinRoots('/home/user/project/../other', ['/home/user/project']),
            ).toBe(false);
        });

        it('rejects a path that merely shares a prefix string', () => {
            // /home/user/projectile is NOT inside /home/user/project even
            // though the string starts the same way.
            expect(
                isWithinRoots('/home/user/projectile', ['/home/user/project']),
            ).toBe(false);
        });
    });

    describe('multiple roots', () => {
        it('returns true if the candidate is inside any root', () => {
            expect(
                isWithinRoots('/home/user/b/file.ts', [
                    '/home/user/a',
                    '/home/user/b',
                    '/home/user/c',
                ]),
            ).toBe(true);
        });

        it('returns false if the candidate is outside all roots', () => {
            expect(
                isWithinRoots('/home/user/z/file.ts', [
                    '/home/user/a',
                    '/home/user/b',
                ]),
            ).toBe(false);
        });

        it('ignores empty/invalid root entries and keeps checking the rest', () => {
            expect(
                isWithinRoots('/home/user/b/file.ts', [
                    '',
                    undefined as unknown as string,
                    '/home/user/b',
                ]),
            ).toBe(true);
        });
    });

    describe('degenerate inputs', () => {
        it('returns false for an empty roots array', () => {
            expect(isWithinRoots('/home/user/project', [])).toBe(false);
        });

        it('returns false when roots is not an array', () => {
            expect(
                isWithinRoots('/home/user/project', null as unknown as string[]),
            ).toBe(false);
        });

        it('returns false for empty candidate', () => {
            expect(isWithinRoots('', ['/home/user/project'])).toBe(false);
        });

        it('returns false for non-string candidate', () => {
            expect(
                isWithinRoots(undefined as unknown as string, ['/home/user/project']),
            ).toBe(false);
            expect(
                isWithinRoots(null as unknown as string, ['/home/user/project']),
            ).toBe(false);
        });

        it('returns false for a whitespace-only candidate against an unrelated root', () => {
            // `'   '` is truthy so it slips past the empty-check, but it
            // resolves to <cwd>/'   ' which is not inside `/nonexistent-root`.
            expect(isWithinRoots('   ', ['/nonexistent-root-xyz'])).toBe(false);
        });
    });

    describe('non-existent paths (realpath fallback)', () => {
        it('returns true for a not-yet-created file under an existing root', () => {
            const candidate = path.join(TMP, 'does', 'not', 'exist', 'yet.ts');
            expect(isWithinRoots(candidate, [TMP])).toBe(true);
        });

        it('returns false when a non-existent path resolves outside the root', () => {
            const root = path.join(TMP, 'root-a');
            const candidate = path.join(TMP, 'root-b', 'file.ts');
            expect(isWithinRoots(candidate, [root])).toBe(false);
        });
    });
});

describe('assertWithinRoots', () => {
    it('does not throw for in-bounds paths', () => {
        expect(() =>
            assertWithinRoots('/home/user/project/file.ts', ['/home/user/project']),
        ).not.toThrow();
    });

    it('throws a tagged error for out-of-bounds paths', () => {
        expect(() =>
            assertWithinRoots('/home/user/other/file.ts', ['/home/user/project']),
        ).toThrow('path-scope:out-of-bounds');
    });

    it('throws for an empty candidate', () => {
        expect(() =>
            assertWithinRoots('', ['/home/user/project']),
        ).toThrow('path-scope:out-of-bounds');
    });

    it('throws when roots array is empty', () => {
        expect(() =>
            assertWithinRoots('/home/user/project', []),
        ).toThrow('path-scope:out-of-bounds');
    });
});
