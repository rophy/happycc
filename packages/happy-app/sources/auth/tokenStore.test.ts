import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    LoggedOutError,
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
        expect(storage.state.value?.refreshToken).toBe('rt-1');

        await store.refresh(first);
        expect(server.calls.map((call) => call.body.refreshToken)).toEqual(['rt-1', 'rt-2']);
        expect(storage.state.value?.refreshToken).toBe('rt-3');
        expect(store.hasPendingRotation()).toBe(false);
        expect(onLoggedOut).not.toHaveBeenCalled();
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
});
