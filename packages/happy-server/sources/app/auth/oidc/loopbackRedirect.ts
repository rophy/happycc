const LOOPBACK_REDIRECT = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/callback$/;

/**
 * RFC 8252 loopback redirect for happy-agent: exactly `http://127.0.0.1:<port>/callback`
 * or `http://[::1]:<port>/callback`, port 1–65535. Returns the URI unchanged, or null.
 * The regex pins the exact shape (no localhost, userinfo, other path, query or fragment);
 * URL parsing double-checks that a WHATWG parser reads it the same way.
 */
export function parseLoopbackRedirectUri(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    const match = LOOPBACK_REDIRECT.exec(value);
    if (!match) {
        return null;
    }
    const port = Number(match[2]);
    if (port < 1 || port > 65535) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (
        url.protocol !== 'http:'
        || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')
        || url.username !== ''
        || url.password !== ''
        || url.pathname !== '/callback'
        || url.search !== ''
        || url.hash !== ''
    ) {
        return null;
    }
    return value;
}
