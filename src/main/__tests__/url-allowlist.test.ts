import { describe, it, expect } from 'vitest';

import { isAllowedExternalUrl, sanitizeExternalUrl } from '../security/url-allowlist';

describe('isAllowedExternalUrl', () => {
    describe('accepted schemes', () => {
        it('accepts http URLs', () => {
            expect(isAllowedExternalUrl('http://example.com')).toBe(true);
            expect(isAllowedExternalUrl('http://example.com/a/b?c=d')).toBe(true);
        });

        it('accepts https URLs', () => {
            expect(isAllowedExternalUrl('https://example.com')).toBe(true);
            expect(isAllowedExternalUrl('https://example.com/path#frag')).toBe(true);
        });

        it('accepts mailto URLs with an address', () => {
            expect(isAllowedExternalUrl('mailto:user@example.com')).toBe(true);
        });

        it('accepts mailto: with no address (protocol-only)', () => {
            // WHATWG URL parses `mailto:` as a valid URL with empty pathname.
            expect(isAllowedExternalUrl('mailto:')).toBe(true);
        });

        it('trims leading/trailing whitespace before parsing', () => {
            expect(isAllowedExternalUrl('   https://example.com   ')).toBe(true);
        });
    });

    describe('rejected inputs', () => {
        it('rejects empty string', () => {
            expect(isAllowedExternalUrl('')).toBe(false);
        });

        it('rejects whitespace-only string', () => {
            expect(isAllowedExternalUrl('   ')).toBe(false);
            expect(isAllowedExternalUrl('\t\n')).toBe(false);
        });

        it('rejects non-string input', () => {
            // Intentional runtime misuse.
            expect(isAllowedExternalUrl(undefined as unknown as string)).toBe(false);
            expect(isAllowedExternalUrl(null as unknown as string)).toBe(false);
            expect(isAllowedExternalUrl(42 as unknown as string)).toBe(false);
        });

        it('rejects unparseable strings', () => {
            expect(isAllowedExternalUrl('not a url')).toBe(false);
            expect(isAllowedExternalUrl('://bad')).toBe(false);
        });
    });

    describe('dangerous schemes', () => {
        it('rejects javascript:', () => {
            expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
        });

        it('rejects file:', () => {
            expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
        });

        it('rejects vscode:', () => {
            expect(isAllowedExternalUrl('vscode://file/etc/passwd')).toBe(false);
        });

        it('rejects ms-cxh-full:', () => {
            expect(isAllowedExternalUrl('ms-cxh-full://attack')).toBe(false);
        });

        it('rejects data: URLs', () => {
            expect(isAllowedExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        });

        it('rejects chrome-extension:', () => {
            expect(isAllowedExternalUrl('chrome-extension://abcdef/page.html')).toBe(false);
        });

        it('rejects ftp:', () => {
            expect(isAllowedExternalUrl('ftp://ftp.example.com/file')).toBe(false);
        });
    });
});

describe('sanitizeExternalUrl', () => {
    it('returns a normalized href for http/https', () => {
        expect(sanitizeExternalUrl('https://example.com')).toBe('https://example.com/');
        expect(sanitizeExternalUrl('http://example.com/a')).toBe('http://example.com/a');
    });

    it('returns a normalized href for mailto:', () => {
        expect(sanitizeExternalUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
    });

    it('strips user:pass credentials from https URLs', () => {
        const out = sanitizeExternalUrl('https://user:pass@example.com/x');
        expect(out).not.toBeNull();
        expect(out).not.toContain('user');
        expect(out).not.toContain('pass');
        // Round-trip through URL to confirm credentials are empty.
        const parsed = new URL(out as string);
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
        expect(parsed.hostname).toBe('example.com');
        expect(parsed.pathname).toBe('/x');
    });

    it('strips a bare username (no password) as well', () => {
        const out = sanitizeExternalUrl('https://user@example.com/');
        expect(out).not.toBeNull();
        const parsed = new URL(out as string);
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
    });

    it('returns null for empty/whitespace input', () => {
        expect(sanitizeExternalUrl('')).toBeNull();
        expect(sanitizeExternalUrl('   ')).toBeNull();
    });

    it('returns null for non-string input', () => {
        expect(sanitizeExternalUrl(undefined as unknown as string)).toBeNull();
        expect(sanitizeExternalUrl(null as unknown as string)).toBeNull();
    });

    it('returns null for unparseable strings', () => {
        expect(sanitizeExternalUrl('not a url')).toBeNull();
    });

    it('returns null for rejected schemes (mirrors isAllowedExternalUrl)', () => {
        expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull();
        expect(sanitizeExternalUrl('file:///etc/passwd')).toBeNull();
        expect(sanitizeExternalUrl('vscode://file/x')).toBeNull();
        expect(sanitizeExternalUrl('ms-cxh-full://attack')).toBeNull();
        expect(sanitizeExternalUrl('data:text/html,<x>')).toBeNull();
        expect(sanitizeExternalUrl('chrome-extension://id/page.html')).toBeNull();
        expect(sanitizeExternalUrl('ftp://ftp.example.com/')).toBeNull();
    });
});
