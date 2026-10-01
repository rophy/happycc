/** Parsing for the OIDC sign-in return URLs. No imports: loaded before the router starts. */

/** Web: the server redirects to `${WEBAPP_URL}/auth/callback#code=<exchangeCode>`. */
export function parseWebCallbackHash(hash: string): string | null {
    const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    return params.get('code') || null;
}

/** Mobile: the server redirects to `${redirectUri}?code=<exchangeCode>`. */
export function parseMobileCallbackUrl(url: string, redirectUri: string): string | null {
    if (!url.startsWith(`${redirectUri}?`)) {
        return null;
    }
    return new URLSearchParams(url.slice(redirectUri.length + 1)).get('code') || null;
}

/** `scheme://auth/callback…`, `/auth/callback…` or `auth/callback…`. */
export function isAuthCallbackPath(path: string): boolean {
    return /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)?auth\/callback(?:[?#]|$)/i.test(path);
}
