import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJwt, startFakeAuthServer } from '@/testing/fakeAuthServer';

const mockConfiguration = vi.hoisted(() => ({
    happyHomeDir: '', privateKeyFile: '', settingsFile: '', serverUrl: '', currentCliVersion: 'test',
}));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import * as persistence from '@/persistence';
import { readCredentials, writeCredentials, type Credentials } from '@/persistence';
import { LoggedOutError, tokenStore } from './tokenStore';

let dir: string;
let server: Awaited<ReturnType<typeof startFakeAuthServer>> | null = null;

const keys = { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) };

async function seed(token: string, refreshToken = 'rt-1'): Promise<Credentials> {
    const creds: Credentials = { token, refreshToken, encryption: keys };
    await writeCredentials(creds);
    return creds;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-tokens-'));
    mockConfiguration.happyHomeDir = dir;
    mockConfiguration.privateKeyFile = join(dir, 'access.key');
    mockConfiguration.settingsFile = join(dir, 'settings.json');
    tokenStore.resetForTests();
});
afterEach(async () => {
    tokenStore.resetForTests();
    await server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
});

describe('tokenStore', () => {
    it('returns a fresh token without refreshing', async () => {
        const token = makeJwt(900);
        tokenStore.init(await seed(token));
        expect(tokenStore.current()).toBe(token);
        expect(await tokenStore.getAccessToken()).toBe(token);
    });

    it('refreshes an expiring token and persists the rotation', async () => {
        const next = makeJwt(900);
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': (body) => body.refreshToken === 'rt-1'
                ? { status: 200, body: { accessToken: next, refreshToken: 'rt-2' } }
                : { status: 401, body: { error: 'invalid_grant', reason: 'invalid' } },
        });
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(makeJwt(30)));
        expect(await tokenStore.getAccessToken()).toBe(next);
        expect(tokenStore.current()).toBe(next);
        expect((await readCredentials())?.refreshToken).toBe('rt-2');
    });

    it('adopts a token another process already rotated instead of refreshing', async () => {
        server = await startFakeAuthServer({});
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const rotatedElsewhere = makeJwt(900);
        await seed(rotatedElsewhere, 'rt-2');
        expect(await tokenStore.refresh(stale)).toBe(rotatedElsewhere);
        expect(server.calls).toEqual([]);
    });

    it('single-flights concurrent refreshes', async () => {
        let calls = 0;
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => { calls++; return { status: 200, body: { accessToken: makeJwt(900), refreshToken: `rt-${calls + 1}` } }; },
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const results = await Promise.all([tokenStore.refresh(stale), tokenStore.refresh(stale), tokenStore.getAccessToken()]);
        expect(new Set(results).size).toBe(1);
        expect(calls).toBe(1);
    });

    it('logs out on invalid_grant, clears credentials and notifies listeners', async () => {
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 401, body: { error: 'invalid_grant', reason: 'revoked' } }),
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const listener = vi.fn();
        tokenStore.onLoggedOut(listener);
        await expect(tokenStore.refresh(stale)).rejects.toBeInstanceOf(LoggedOutError);
        expect(await readCredentials()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('bounds the refresh request with a hard abort deadline, not just the post-connect socket timeout', async () => {
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: makeJwt(900), refreshToken: 'rt-2' } }),
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const postSpy = vi.spyOn(axios, 'post');
        await tokenStore.refresh(stale);
        const options = postSpy.mock.calls.at(-1)?.[2] as { signal?: unknown } | undefined;
        // `timeout` (axios' req.setTimeout) only bounds the socket after it connects; a
        // black-holed route can hang in DNS/connect for minutes otherwise, holding the
        // credentials lock well past its 30s stale window. The abort signal is a hard
        // wall-clock deadline that also covers DNS + connect.
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        postSpy.mockRestore();
    });

    it('sanitizes an aborted refresh the same way as any other network error', async () => {
        server = await startFakeAuthServer({});
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        // Force the abort branch deterministically (rather than racing a real hang)
        // by pre-aborting the signal handed to axios; this exercises the exact
        // catch path a DNS/connect-phase hang would take.
        const originalPost = axios.post.bind(axios);
        const postSpy = vi.spyOn(axios, 'post').mockImplementation(async (url, data, options: any) => {
            return originalPost(url, data, { ...options, signal: AbortSignal.abort() });
        });
        await expect(tokenStore.refresh(stale)).rejects.not.toBeInstanceOf(LoggedOutError);
        await expect(tokenStore.refresh(stale)).rejects.toThrow(/^Token refresh failed: /);
        expect((await readCredentials())?.token).toBe(stale);
        postSpy.mockRestore();
    });

    it('keeps credentials on network errors and never leaks the raw axios error', async () => {
        mockConfiguration.serverUrl = 'http://127.0.0.1:9'; // closed port
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        await expect(tokenStore.refresh(stale)).rejects.not.toBeInstanceOf(LoggedOutError);
        await expect(tokenStore.refresh(stale)).rejects.toThrow(/^Token refresh failed: /);
        expect((await readCredentials())?.token).toBe(stale);
    });

    it('does not log out on a 401 that is not invalid_grant', async () => {
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 401, body: { error: 'temporarily_unavailable' } }),
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        const listener = vi.fn();
        tokenStore.onLoggedOut(listener);
        await expect(tokenStore.refresh(stale)).rejects.not.toBeInstanceOf(LoggedOutError);
        expect(await readCredentials()).not.toBeNull();
        expect(listener).not.toHaveBeenCalled();
    });

    it('keeps a rotation pending in memory when the write fails, and persists it without a second POST', async () => {
        let refreshCalls = 0;
        const next = makeJwt(900);
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => {
                refreshCalls++;
                return { status: 200, body: { accessToken: next, refreshToken: 'rt-2' } };
            },
        });
        mockConfiguration.serverUrl = server.url;
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));

        const writeSpy = vi.spyOn(persistence, 'writeCredentials').mockImplementationOnce(async () => {
            throw new Error('disk full');
        });

        const first = await tokenStore.refresh(stale);
        expect(first).toBe(next);
        expect(refreshCalls).toBe(1);
        expect(tokenStore.current()).toBe(next);

        writeSpy.mockRestore();

        const second = await tokenStore.refresh(next);
        expect(second).toBe(next);
        expect(refreshCalls).toBe(1);
        expect((await readCredentials())?.token).toBe(next);
        expect((await readCredentials())?.refreshToken).toBe('rt-2');
    });

    it('retries a 401 once with a refreshed token via the axios interceptor', async () => {
        const fresh = makeJwt(900);
        const stale = makeJwt(600);
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: fresh, refreshToken: 'rt-2' } }),
            'GET /v1/whoami': (_body, req) => req.headers.authorization === `Bearer ${fresh}`
                ? { status: 200, body: { ok: true } }
                : { status: 401, body: { error: 'Invalid token' } },
        });
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(stale));
        const res = await axios.get(`${server.url}/v1/whoami`, { headers: { Authorization: `Bearer ${stale}` } });
        expect(res.data).toEqual({ ok: true });
        expect(server.calls.filter((c) => c.path === '/v1/whoami')).toHaveLength(2);
    });

    it('retries persisting a pending rotation within 30s instead of waiting for the next natural refresh', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            let refreshCalls = 0;
            const next = makeJwt(900);
            server = await startFakeAuthServer({
                'POST /v1/auth/refresh': () => {
                    refreshCalls++;
                    return { status: 200, body: { accessToken: next, refreshToken: 'rt-2' } };
                },
            });
            mockConfiguration.serverUrl = server.url;
            const stale = makeJwt(30);
            tokenStore.init(await seed(stale));

            const writeSpy = vi.spyOn(persistence, 'writeCredentials').mockImplementationOnce(async () => {
                throw new Error('disk full');
            });

            await tokenStore.refresh(stale);
            expect(refreshCalls).toBe(1);
            expect((await readCredentials())?.token).toBe(stale); // not yet persisted

            writeSpy.mockRestore();

            await vi.advanceTimersByTimeAsync(30_000);
            // The scheduled retry fires a fire-and-forget refresh(); its lock acquisition and
            // file write are real async I/O that fake timers do not drive, so wait for it with
            // real timers before asserting on disk state.
            vi.useRealTimers();
            await vi.waitFor(async () => {
                expect((await readCredentials())?.token).toBe(next);
            }, { timeout: 2000, interval: 20 });

            expect(refreshCalls).toBe(1); // no second POST
            expect((await readCredentials())?.refreshToken).toBe('rt-2');
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not retry a request a second time if the refreshed token still gets a 401', async () => {
        let whoamiCalls = 0;
        server = await startFakeAuthServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: makeJwt(900), refreshToken: 'rt-2' } }),
            'GET /v1/whoami': () => {
                whoamiCalls++;
                return { status: 401, body: { error: 'Invalid token' } };
            },
        });
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(makeJwt(600)));
        await expect(axios.get(`${server.url}/v1/whoami`, { headers: { Authorization: 'Bearer stale-token' } })).rejects.toThrow();
        expect(whoamiCalls).toBe(2);
    });

    it('does not retry requests to other hosts', async () => {
        const other = await startFakeAuthServer({ 'GET /x': () => ({ status: 401, body: {} }) });
        server = await startFakeAuthServer({});
        mockConfiguration.serverUrl = server.url;
        tokenStore.init(await seed(makeJwt(900)));
        await expect(axios.get(`${other.url}/x`, { headers: { Authorization: 'Bearer abc' } })).rejects.toThrow();
        expect(other.calls).toHaveLength(1);
        await other.close();
    });
});
