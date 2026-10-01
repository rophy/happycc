import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFetch, getAccessToken, headersToRecord, setAccessTokenProvider, setServerUrlAccessor, staticAccessTokenProvider } from './authFetch';
import { LoggedOutError, type AccessTokenProvider } from './tokenStore';

const SERVER = 'https://happy.test';

afterEach(() => {
    setAccessTokenProvider(null);
    setServerUrlAccessor(null);
    vi.unstubAllGlobals();
});

function stubFetch(...statuses: number[]) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: statuses.shift() ?? 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('authFetch', () => {
    it('attaches the current access token to server requests and keeps other headers', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('tok-1', SERVER));
        const fetchMock = stubFetch(200);
        await authFetch(`${SERVER}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/v1/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-1' },
            body: '{}',
        });
    });

    it('retries a 401 once with a refreshed token', async () => {
        const refresh = vi.fn(async () => 'tok-new');
        const provider: AccessTokenProvider = { serverUrl: () => SERVER, getAccessToken: async () => 'tok-old', refresh };
        setAccessTokenProvider(provider);
        const fetchMock = stubFetch(401, 200);
        const response = await authFetch(`${SERVER}/v1/machines`);
        expect(response.status).toBe(200);
        expect(refresh).toHaveBeenCalledWith('tok-old');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect((fetchMock.mock.calls[1] as any)[1].headers.Authorization).toBe('Bearer tok-new');
    });

    it('returns the second 401 without retrying again', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('tok-1', SERVER));
        const fetchMock = stubFetch(401, 401, 200);
        const response = await authFetch(`${SERVER}/v1/machines`);
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('passes requests to other origins through untouched and never retries them', async () => {
        const refresh = vi.fn(async () => 'tok-new');
        setAccessTokenProvider({ serverUrl: () => SERVER, getAccessToken: async () => 'tok-1', refresh });
        const fetchMock = stubFetch(401);
        const response = await authFetch('https://files.test/blob?sig=1');
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledWith('https://files.test/blob?sig=1', undefined);
        const other = stubFetch(200);
        await authFetch('https://happy.test:444/v1/x', { headers: { A: 'b' } });
        expect(other).toHaveBeenCalledWith('https://happy.test:444/v1/x', { headers: { A: 'b' } });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('rejects with LoggedOutError when nobody is signed in', async () => {
        stubFetch(200);
        await expect(authFetch(`${SERVER}/v1/x`)).rejects.toBeInstanceOf(LoggedOutError);
        await expect(getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });

    it('does not retry a 401 when the request body is a ReadableStream', async () => {
        const refresh = vi.fn(async () => 'tok-new');
        setAccessTokenProvider({ serverUrl: () => SERVER, getAccessToken: async () => 'tok-old', refresh });
        const fetchMock = stubFetch(401, 200);
        const response = await authFetch(`${SERVER}/v1/upload`, { method: 'POST', body: new ReadableStream() });
        expect(response.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('passes other-origin requests through even when nobody is signed in', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('tok-1', SERVER));
        setAccessTokenProvider(null); // signed out; the server's origin is still remembered
        const fetchMock = stubFetch(200);
        const response = await authFetch('https://files.test/blob?sig=1');
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledWith('https://files.test/blob?sig=1', undefined);
    });

    it('passes other-origin requests through when no provider has ever been set, using the injected server URL accessor', async () => {
        setServerUrlAccessor(() => SERVER);
        const fetchMock = stubFetch(200);
        const response = await authFetch('https://files.test/blob?sig=1');
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledWith('https://files.test/blob?sig=1', undefined);
    });

    it('strips any existing Authorization header case-insensitively before attaching ours', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('tok-1', SERVER));
        const fetchMock = stubFetch(200);
        await authFetch(`${SERVER}/v1/x`, { headers: { authorization: 'Bearer stale', 'X-Keep': '1' } });
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/v1/x`, {
            headers: { 'X-Keep': '1', Authorization: 'Bearer tok-1' },
        });
    });
});

describe('headersToRecord', () => {
    it('accepts Headers, tuples and plain objects', () => {
        expect(headersToRecord(new Headers({ 'X-A': '1' }))).toEqual({ 'x-a': '1' });
        expect(headersToRecord([['X-B', '2']])).toEqual({ 'X-B': '2' });
        expect(headersToRecord({ 'X-C': '3' })).toEqual({ 'X-C': '3' });
        expect(headersToRecord(undefined)).toEqual({});
    });
});
