/**
 * Captures the `#code` of the web OIDC callback at startup, before the router
 * reads the URL, and removes it from the address bar (spec §2 "Web app").
 * Imported from packages/happy-app/index.ts ahead of expo-router.
 */
import { parseWebCallbackHash } from './callbackUrls';

let captured: string | null = null;

function capture(): void {
    if (typeof window === 'undefined' || !window.location || typeof window.location.pathname !== 'string' || !window.history) {
        return; // native
    }
    // expo-router serves the route with or without one trailing slash.
    const pathname = window.location.pathname.replace(/\/$/, '');
    if (!pathname.endsWith('/auth/callback')) {
        return;
    }
    captured = parseWebCallbackHash(window.location.hash);
    if (window.location.hash) {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
}

capture();

/** The captured exchange code, once. */
export function takeWebCallbackCode(): string | null {
    const code = captured;
    captured = null;
    return code;
}
