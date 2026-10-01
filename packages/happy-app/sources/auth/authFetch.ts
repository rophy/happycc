/**
 * The one place that attaches the access token to HTTP requests. Pure (no React
 * Native imports): the runtime registers the TokenStore via setAccessTokenProvider.
 */
import { LoggedOutError, type AccessTokenProvider } from './tokenStore';

let provider: AccessTokenProvider | null = null;

export function setAccessTokenProvider(next: AccessTokenProvider | null): void {
    provider = next;
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
    return { ...init, headers: { ...headersToRecord(init?.headers), Authorization: `Bearer ${token}` } };
}

/**
 * fetch() for the Happy server: attaches `Authorization: Bearer <access token>` and
 * retries once after a 401 with a refreshed token. Other origins (presigned storage
 * URLs, CDNs) are passed through untouched. Bodies must be re-sendable (string,
 * ArrayBuffer, Blob, FormData), which every caller in this app uses.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
    const current = provider;
    if (!current) {
        throw new LoggedOutError();
    }
    if (!sameOrigin(url, current.serverUrl())) {
        return fetch(url, init);
    }
    const token = await current.getAccessToken();
    const response = await fetch(url, withBearer(init, token));
    if (response.status !== 401) {
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
