import { describe, it, expect } from 'vitest';

import { compareVersions } from '../version';

describe('compareVersions', () => {
    it.each([
        ['0.13.0', '0.13.0'],
        ['v0.13.0', '0.13.0'],
        ['0.13.0', 'v0.13.0'],
        ['1.2', '1.2.0'],
    ])('treats %s and %s as equal', (a, b) => {
        expect(compareVersions(a, b)).toBe(0);
    });

    it.each([
        ['0.14.0', '0.13.0'],
        ['0.13.1', '0.13.0'],
        ['1.0.0', '0.99.99'],
        // Numeric, not lexicographic, per component.
        ['0.10.0', '0.9.0'],
        ['0.13.10', '0.13.9'],
        ['v2.0.0', '1.9.9'],
    ])('orders %s after %s', (newer, older) => {
        expect(compareVersions(newer, older)).toBeGreaterThan(0);
        expect(compareVersions(older, newer)).toBeLessThan(0);
    });

    it('ignores non-numeric components instead of failing', () => {
        expect(compareVersions('0.13.0-beta', '0.13.0')).toBe(0);
        expect(compareVersions('nightly', '0.0.0')).toBe(0);
    });
});
