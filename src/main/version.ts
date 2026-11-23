/**
 * Compare two semver-ish versions or release tags ("0.5.5", "v0.6.0").
 * Returns a negative number if a < b, zero if equal, positive if a > b.
 * Missing components count as 0 and non-numeric components are ignored
 * (treated as 0), so pre-release suffixes are not ordered by semver
 * rules — fine for comparing published release tags.
 */
export function compareVersions(a: string, b: string): number {
    const normalize = (s: string): number[] =>
        s.replace(/^v/, '').split(/[.\-+]/).map((p) => {
            const n = parseInt(p, 10);
            return Number.isFinite(n) ? n : 0;
        });
    const aa = normalize(a);
    const bb = normalize(b);
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
        const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
