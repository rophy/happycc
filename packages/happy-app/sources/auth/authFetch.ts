/**
 * The one place that attaches the access token to HTTP requests. Pure (no React
 * Native imports): the runtime registers the TokenStore via setAccessTokenProvider.
 */
import { LoggedOutError, type AccessTokenProvider } from './tokenStore';

let provider: AccessTokenProvider | null = null;
/**
 * The server origin is static app config, independent of sign-in state — remembered
 * across `setAccessTokenProvider(null)` so other-origin requests (S3, CDN) keep
 * passing through untouched even while signed out, instead of being rejected as
 * LoggedOutError before we ever look at their origin.
 */
let lastKnownServerUrl: string | null = null;

export function setAccessTokenProvider(next: AccessTokenProvider | null): void {
    provider = next;
    if (next) {
        lastKnownServerUrl = next.serverUrl();
    }
}

export function getAccessToken(): Promise<string> {
    return provider ? provider.getAccessToken() : Promise.reject(new LoggedOutError());
}

export function headersToRecord(headers?: HeadersInit): Record<string, string> {
    if (!headers) {
        return {};
    }
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const record: Record<string, string> = {};
        headers.forEach((value, key) => { record[key] = value; });
        return record;
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return { ...(headers as Record<string, string>) };
}

function sameOrigin(url: string, serverUrl: string): boolean {
    try {
        return new URL(url).origin === new URL(serverUrl).origin;
    } catch {
        return false;
    }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
    const headers = headersToRecord(init?.headers);
    // Strip any existing Authorization the caller set, case-insensitively, before
    // setting ours — otherwise a duplicate-cased key could win depending on the
    // underlying fetch implementation's header handling.
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') {
            delete headers[key];
        }
    }
    headers.Authorization = `Bearer ${token}`;
    return { ...init, headers };
}

function isReadableStreamBody(body: BodyInit | null | undefined): boolean {
    return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
}

/**
 * fetch() for the Happy server: attaches `Authorization: Bearer <access token>` and
 * retries once after a 401 with a refreshed token. Other origins (presigned storage
 * URLs, CDNs) are passed through untouched — checked before requiring a signed-in
 * provider, so those requests still work while signed out. Bodies must be re-sendable
 * (string, ArrayBuffer, Blob, FormData) to survive a retry; a `ReadableStream` body
 * can't be re-sent, so a 401 on one is returned as-is without retrying.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
    const current = provider;
    const knownServerUrl = current ? current.serverUrl() : lastKnownServerUrl;
    if (knownServerUrl !== null && !sameOrigin(url, knownServerUrl)) {
        return fetch(url, init);
    }
    if (!current) {
        throw new LoggedOutError();
    }
    const token = await current.getAccessToken();
    const response = await fetch(url, withBearer(init, token));
    if (response.status !== 401 || isReadableStreamBody(init?.body)) {
        return response;
    }
    const fresh = await current.refresh(token);
    return fetch(url, withBearer(init, fresh));
}

/** A provider with a fixed token, for tests. */
export function staticAccessTokenProvider(token: string, serverUrl: string): AccessTokenProvider {
    return {
        serverUrl: () => serverUrl,
        getAccessToken: async () => token,
        refresh: async () => token,
    };
}
