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

    it('keeps credentials on network errors', async () => {
        mockConfiguration.serverUrl = 'http://127.0.0.1:9'; // closed port
        const stale = makeJwt(30);
        tokenStore.init(await seed(stale));
        await expect(tokenStore.refresh(stale)).rejects.not.toBeInstanceOf(LoggedOutError);
        expect((await readCredentials())?.token).toBe(stale);
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
