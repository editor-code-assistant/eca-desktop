// ============================================================
// URL allowlist — defense against dangerous schemes being handed
// to `shell.openExternal`. Only http/https/mailto are accepted.
// Everything else (javascript:, file:, vscode:, ms-cxh-full:,
// custom protocol handlers, etc.) is rejected.
// ============================================================

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns true if the URL is safe to hand to `shell.openExternal`.
 *
 * Accepts only `http:`, `https:`, and `mailto:`. Empty/whitespace
 * input and unparseable URLs are rejected.
 */
export function isAllowedExternalUrl(raw: string): boolean {
    if (typeof raw !== 'string') return false;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return false;

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return false;
    }

    return ALLOWED_PROTOCOLS.has(parsed.protocol);
}

/**
 * Returns a normalized safe URL string, or `null` if the input is
 * rejected. Strips any embedded credentials (`url.username` /
 * `url.password`) before returning `href`.
 *
 * For `mailto:` the input is accepted with or without a hostname
 * (e.g. `mailto:user@example.com` parses with empty host).
 */
export function sanitizeExternalUrl(raw: string): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;

    // Strip credentials — embedded user:pass@host is a common phishing
    // / tracking vector and is never required for legitimate links.
    parsed.username = '';
    parsed.password = '';

    return parsed.href;
}
