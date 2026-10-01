import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    LoggedOutError,
    RETRY_AFTER_ERROR_MS,
    TokenStore,
    parseStoredCredentials,
    type StoredCredentials,
    type TokenStoreDeps,
} from './tokenStore';

const SERVER = 'https://happy.test';

function makeJwt(expSecondsFromNow: number): string {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'acc_1', did: 'dev_1', typ: 'access', exp })}.sig`;
}

function creds(token: string, refreshToken = 'rt-1'): StoredCredentials {
    return { token, refreshToken, secret: 'root-secret' };
}

type Handler = (path: string, body: any) => { status: number; body: unknown };

function fakeServer(handler: Handler) {
    const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = new URL(String(input)).pathname;
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ path, body, headers: (init.headers ?? {}) as Record<string, string> });
        const result = handler(path, body);
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** A refresh endpoint that rotates like the server: only the latest refresh token is accepted. */
function rotatingServer() {
    let valid = 'rt-1';
    let n = 1;
    return fakeServer((path, body) => {
        if (path !== '/v1/auth/refresh') return { status: 404, body: {} };
        if (body.refreshToken !== valid) return { status: 401, body: { error: 'invalid_grant', reason: 'reused' } };
        n += 1;
        valid = `rt-${n}`;
        return { status: 200, body: { accessToken: makeJwt(900), refreshToken: valid } };
    });
}

function memoryStorage(initial: StoredCredentials | null) {
    const state = { value: initial };
    return {
        state,
        read: vi.fn(async () => state.value),
        write: vi.fn(async (c: StoredCredentials) => { state.value = c; }),
        clearIfRefreshToken: vi.fn(async (refreshToken: string) => {
            if (state.value?.refreshToken === refreshToken) state.value = null;
        }),
    };
}

function mutex() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

const stores: TokenStore[] = [];
function track(store: TokenStore): TokenStore {
    stores.push(store);
    return store;
}
afterEach(() => {
    stores.splice(0).forEach((store) => store.stop());
    vi.useRealTimers();
});

function deps(storage: ReturnType<typeof memoryStorage>, fetchImpl: typeof fetch, extra: Partial<TokenStoreDeps> = {}): TokenStoreDeps {
    return {
        serverUrl: () => SERVER,
        read: storage.read,
        write: storage.write,
        clearIfRefreshToken: storage.clearIfRefreshToken,
        onLoggedOut: vi.fn(),
        fetch: fetchImpl,
        clientId: () => 'web/test',
        ...extra,
    };
}

describe('parseStoredCredentials', () => {
    it('accepts complete credentials and rejects legacy or broken values', () => {
        expect(parseStoredCredentials(JSON.stringify(creds('t')))).toEqual(creds('t'));
        expect(parseStoredCredentials(JSON.stringify({ token: 't', secret: 's' }))).toBeNull();
        expect(parseStoredCredentials(JSON.stringify({ token: 't', refreshToken: '', secret: 's' }))).toBeNull();
        expect(parseStoredCredentials('{nope')).toBeNull();
        expect(parseStoredCredentials(null)).toBeNull();
    });
});

describe('TokenStore', () => {
    it('returns a fresh token without calling the server', async () => {
        const token = makeJwt(900);
        const server = rotatingServer();
        const storage = memoryStorage(creds(token));
        const store = track(new TokenStore(creds(token), deps(storage, server.fetchImpl)));
        await expect(store.getAccessToken()).resolves.toBe(token);
        expect(server.calls).toHaveLength(0);
    });

    it('refreshes an expiring token once for concurrent callers and persists the rotation', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl)));
        const results = await Promise.all([store.getAccessToken(), store.getAccessToken(), store.refresh(stale)]);
        expect(new Set(results).size).toBe(1);
        expect(results[0]).not.toBe(stale);
        expect(server.calls).toHaveLength(1);
        expect(server.calls[0]).toMatchObject({ path: '/v1/auth/refresh', body: { refreshToken: 'rt-1' } });
        expect(server.calls[0].headers['X-Happy-Client']).toBe('web/test');
        expect(storage.state.value).toEqual({ token: results[0], refreshToken: 'rt-2', secret: 'root-secret' });
        expect(store.current().refreshToken).toBe('rt-2');
    });

    it('adopts a token another tab already rotated instead of refreshing', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const rotatedElsewhere = creds(makeJwt(900), 'rt-9');
        const storage = memoryStorage(rotatedElsewhere);
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl)));
        await expect(store.refresh(stale)).resolves.toBe(rotatedElsewhere.token);
        expect(server.calls).toHaveLength(0);
        expect(store.current()).toEqual(rotatedElsewhere);
    });

    it('redeems the refresh token once when two tabs refresh under a shared lock', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        const lock = mutex();
        const onLoggedOut = vi.fn();
        const tabA = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { withLock: lock, onLoggedOut })));
        const tabB = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { withLock: lock, onLoggedOut })));
        const [a, b] = await Promise.all([tabA.getAccessToken(), tabB.getAccessToken()]);
        expect(a).toBe(b);
        expect(server.calls).toHaveLength(1);
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('logs out on invalid_grant: clears storage, notifies once, then rejects', async () => {
        const stale = makeJwt(60);
        const server = fakeServer(() => ({ status: 401, body: { error: 'invalid_grant', reason: 'revoked' } }));
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
        expect(storage.state.value).toBeNull();
        expect(onLoggedOut).toHaveBeenCalledTimes(1);
        expect(onLoggedOut).toHaveBeenCalledWith('rt-1');
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
        expect(onLoggedOut).toHaveBeenCalledTimes(1);
    });

    it('keeps credentials on network errors and 5xx', async () => {
        const stale = makeJwt(60);
        const failing = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, failing, { onLoggedOut })));
        const error = await store.refresh(stale).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LoggedOutError);

        const server = fakeServer(() => ({ status: 503, body: {} }));
        const store2 = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));
        await expect(store2.refresh(stale)).rejects.toThrow('HTTP 503');
        expect(storage.state.value?.refreshToken).toBe('rt-1');
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('never re-sends a refresh token the server already rotated when persisting fails', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        storage.write.mockRejectedValueOnce(new Error('quota exceeded'));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        const first = await store.getAccessToken();
        expect(store.current().refreshToken).toBe('rt-2');
        expect(store.hasPendingRotation()).toBe(true);
        // The failed write left 'rt-1' in storage, but the server already rotated past it:
        // we clear it so no other tab tries (and fails) to redeem a token that's dead anyway.
        expect(storage.state.value).toBeNull();
        expect(storage.clearIfRefreshToken).toHaveBeenCalledWith('rt-1');

        await store.refresh(first);
        expect(server.calls.map((call) => call.body.refreshToken)).toEqual(['rt-1', 'rt-2']);
        expect(storage.state.value?.refreshToken).toBe('rt-3');
        expect(store.hasPendingRotation()).toBe(false);
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('retries persisting a pending rotation on the proactive timer without redeeming it again', async () => {
        vi.useFakeTimers();
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        storage.write.mockRejectedValueOnce(new Error('quota exceeded'));
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl)));

        await store.getAccessToken();
        expect(store.hasPendingRotation()).toBe(true);
        expect(server.calls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(RETRY_AFTER_ERROR_MS + 1_000);

        expect(server.calls).toHaveLength(1); // no extra /refresh POST — only the persist retried
        expect(store.hasPendingRotation()).toBe(false);
        expect(storage.state.value?.refreshToken).toBe('rt-2');
    });

    it('treats a 401 refresh error other than invalid_grant as a plain Error and keeps credentials', async () => {
        const stale = makeJwt(60);
        const server = fakeServer(() => ({ status: 401, body: { error: 'server_error' } }));
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        const error = await store.refresh(stale).catch((e) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LoggedOutError);
        expect(storage.state.value).toEqual(creds(stale));
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('leaves storage untouched when stop() is called during an in-flight refresh', async () => {
        const stale = makeJwt(60);
        let resolveFetch!: (value: Response) => void;
        const blockedFetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
        const blockedFetch = blockedFetchMock as unknown as typeof fetch;
        const storage = memoryStorage(creds(stale));
        const store = track(new TokenStore(creds(stale), deps(storage, blockedFetch)));

        const pending = store.refresh(stale);
        while (blockedFetchMock.mock.calls.length === 0) {
            await Promise.resolve();
        }
        store.stop();
        resolveFetch(new Response(JSON.stringify({ accessToken: makeJwt(900), refreshToken: 'rt-2' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));

        await expect(pending).rejects.toBeInstanceOf(Error);
        expect(storage.write).not.toHaveBeenCalled();
        expect(storage.state.value).toEqual(creds(stale));
    });

    it('stopAndSettle waits for an in-flight refresh to finish before resolving, fencing its write', async () => {
        const stale = makeJwt(60);
        let resolveFetch!: (value: Response) => void;
        const blockedFetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
        const blockedFetch = blockedFetchMock as unknown as typeof fetch;
        const storage = memoryStorage(creds(stale));
        const store = track(new TokenStore(creds(stale), deps(storage, blockedFetch)));

        const pending = store.refresh(stale).catch(() => {});
        while (blockedFetchMock.mock.calls.length === 0) {
            await Promise.resolve();
        }
        const settle = store.stopAndSettle();
        resolveFetch(new Response(JSON.stringify({ accessToken: makeJwt(900), refreshToken: 'rt-2' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        await settle;
        await pending;

        expect(storage.write).not.toHaveBeenCalled();
        expect(storage.state.value).toEqual(creds(stale));
    });

    it('does not write when storage was cleared by another tab mid-refresh', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        let calls = 0;
        storage.read.mockImplementation(async () => {
            calls += 1;
            // First read: the normal "decide whether to redeem" read. Second read: the
            // CAS check right before writing — simulate another tab logging out meanwhile.
            return calls === 1 ? storage.state.value : null;
        });

        await expect(store.refresh(stale)).rejects.toBeInstanceOf(Error);
        expect(storage.write).not.toHaveBeenCalled();
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('does not write when storage was swapped to a different account mid-refresh', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        let calls = 0;
        const otherAccount = creds(makeJwt(900), 'rt-9');
        otherAccount.secret = 'other-secret';
        storage.read.mockImplementation(async () => {
            calls += 1;
            return calls === 1 ? storage.state.value : otherAccount;
        });

        await expect(store.refresh(stale)).rejects.toBeInstanceOf(Error);
        expect(storage.write).not.toHaveBeenCalled();
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('neither adopts nor redeems credentials of a different account found in storage', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const otherAccount = { ...creds(makeJwt(900), 'rt-9'), secret: 'other-secret' };
        const storage = memoryStorage(otherAccount);
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        await expect(store.refresh(stale)).rejects.toBeInstanceOf(Error);
        expect(store.current().secret).toBe('root-secret');
        expect(server.calls).toHaveLength(0);
        expect(storage.write).not.toHaveBeenCalled();
        expect(onLoggedOut).not.toHaveBeenCalled();
        // Stopped like an external account switch: no further tokens from this store.
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });

    it('refreshes proactively two minutes before expiry', async () => {
        vi.useFakeTimers();
        const token = makeJwt(600);
        const server = rotatingServer();
        const storage = memoryStorage(creds(token));
        const store = track(new TokenStore(creds(token), deps(storage, server.fetchImpl)));
        await vi.advanceTimersByTimeAsync(470_000);
        expect(server.calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(server.calls.map((call) => call.path)).toEqual(['/v1/auth/refresh']);
        expect(store.current().refreshToken).toBe('rt-2');
    });

    it('follows other tabs through storage changes', () => {
        const token = makeJwt(900);
        const storage = memoryStorage(creds(token));
        const store = track(new TokenStore(creds(token), deps(storage, rotatingServer().fetchImpl)));
        expect(store.applyExternalChange(JSON.stringify(creds(token)))).toBe('ignored');
        const rotated = creds(makeJwt(900), 'rt-7');
        expect(store.applyExternalChange(JSON.stringify(rotated))).toBe('adopted');
        expect(store.current()).toEqual(rotated);
        expect(store.applyExternalChange(JSON.stringify({ ...rotated, refreshToken: 'rt-8', secret: 'other-account' }))).toBe('reload');
    });

    it('reloads when another tab logs out, without calling onLoggedOut', async () => {
        const token = makeJwt(900);
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(token), deps(memoryStorage(creds(token)), rotatingServer().fetchImpl, { onLoggedOut })));
        expect(store.applyExternalChange(null)).toBe('reload');
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
        expect(onLoggedOut).not.toHaveBeenCalled();
    });

    it('logs out on the server best-effort and stops', async () => {
        const token = makeJwt(900);
        const server = fakeServer((path) => (path === '/v1/auth/logout' ? { status: 200, body: { success: true } } : { status: 404, body: {} }));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(token), deps(memoryStorage(creds(token)), server.fetchImpl, { onLoggedOut })));
        await store.logoutOnServer(1000);
        expect(server.calls).toHaveLength(1);
        expect(server.calls[0].path).toBe('/v1/auth/logout');
        expect(server.calls[0].headers.Authorization).toBe(`Bearer ${token}`);
        expect(server.calls[0].headers['Content-Type']).toBeUndefined();
        expect(onLoggedOut).not.toHaveBeenCalled();
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });

    it('gives up on a hanging server logout after the timeout', async () => {
        const token = makeJwt(900);
        const hanging = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
        const store = track(new TokenStore(creds(token), deps(memoryStorage(creds(token)), hanging)));
        const started = Date.now();
        await store.logoutOnServer(50);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('fails a refresh with a non-auth error within the timeout when the response body hangs', async () => {
        const stale = makeJwt(60);
        const hangingJsonMock = vi.fn(async () => ({
            status: 200,
            ok: true,
            json: () => new Promise(() => { /* never resolves, and never looks at the abort signal */ }),
        }));
        const hangingJsonFetch = hangingJsonMock as unknown as typeof fetch;
        const storage = memoryStorage(creds(stale));
        const store = track(new TokenStore(creds(stale), deps(storage, hangingJsonFetch, { refreshTimeoutMs: 50 })));

        const started = Date.now();
        const error = await store.refresh(stale).catch((e) => e);

        expect(Date.now() - started).toBeLessThan(2000);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(LoggedOutError);
        expect(storage.write).not.toHaveBeenCalled();
        expect(storage.state.value).toEqual(creds(stale));
    });

    it('stopAndSettle resolves within its own bound even if the in-flight refresh body hangs past it', async () => {
        vi.useFakeTimers();
        const stale = makeJwt(60);
        const hangingJsonMock = vi.fn(async () => ({
            status: 200,
            ok: true,
            json: () => new Promise(() => { /* never resolves */ }),
        }));
        const hangingJsonFetch = hangingJsonMock as unknown as typeof fetch;
        const storage = memoryStorage(creds(stale));
        // refreshTimeoutMs left at its 10s default, intentionally longer than stopAndSettle's
        // own ~6s bound, so this proves stopAndSettle doesn't just inherit the refresh's timeout.
        const store = track(new TokenStore(creds(stale), deps(storage, hangingJsonFetch)));

        const pending = store.refresh(stale).catch(() => {});
        let settled = false;
        const settle = store.stopAndSettle().then(() => { settled = true; });

        await vi.advanceTimersByTimeAsync(7_000);

        expect(settled).toBe(true);
        expect(storage.write).not.toHaveBeenCalled();
        await settle;
        await pending;
    });

    it('does not adopt the refresh token it just rotated past when a failed write\'s clear also fails', async () => {
        const stale = makeJwt(60);
        const server = rotatingServer();
        const storage = memoryStorage(creds(stale));
        storage.write.mockRejectedValueOnce(new Error('quota exceeded'));
        storage.clearIfRefreshToken.mockRejectedValueOnce(new Error('clear failed too'));
        const onLoggedOut = vi.fn();
        const store = track(new TokenStore(creds(stale), deps(storage, server.fetchImpl, { onLoggedOut })));

        const first = await store.getAccessToken();
        expect(store.current().refreshToken).toBe('rt-2'); // kept the new pair in memory
        expect(store.hasPendingRotation()).toBe(true);
        // The clear also failed, so storage still literally holds 'rt-1' — the token we
        // already rotated past. That must not be adopted back as current on the next retry.
        expect(storage.state.value?.refreshToken).toBe('rt-1');

        await store.refresh(first);

        expect(store.current().refreshToken).not.toBe('rt-1');
        expect(onLoggedOut).not.toHaveBeenCalled();
    });
});
