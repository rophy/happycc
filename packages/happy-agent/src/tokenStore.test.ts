import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios, { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { readCredentials, writeCredentials, type StoredCredentials } from './credentials';
import * as credentialsModule from './credentials';
import { getRandomBytes } from './encryption';
import { makeJwt, startFakeServer } from './testing/fakeServer';
import { LoggedOutError, TokenStore, socketAuth, withAuthRetry } from './tokenStore';

const secret = getRandomBytes(32);
let homeDir: string;
let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;

beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-tokens-')); });
afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(homeDir, { recursive: true, force: true });
});

function configFor(serverUrl: string): Config {
    return { serverUrl, homeDir, credentialPath: join(homeDir, 'agent.key') };
}

function seed(config: Config, token: string, refreshToken = 'rt-1', seedSecret = secret): StoredCredentials {
    const creds = { token, refreshToken, secret: seedSecret };
    writeCredentials(config, creds);
    return creds;
}

describe('TokenStore', () => {
    it('returns a fresh token without calling the server', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        const token = makeJwt(900);
        const store = new TokenStore(config, seed(config, token));
        expect(await store.getAccessToken()).toBe(token);
        expect(server.calls).toEqual([]);
    });

    it('refreshes a token that expires within two minutes and persists the rotation', async () => {
        const next = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': (body) => body.refreshToken === 'rt-1'
                ? { status: 200, body: { accessToken: next, refreshToken: 'rt-2' } }
                : { status: 401, body: { error: 'invalid_grant', reason: 'invalid' } },
        });
        const config = configFor(server.url);
        const store = new TokenStore(config, seed(config, makeJwt(90)));
        expect(await store.getAccessToken()).toBe(next);
        const stored = readCredentials(config)!;
        expect(stored.token).toBe(next);
        expect(stored.refreshToken).toBe('rt-2');
        expect(Buffer.from(stored.secret).equals(Buffer.from(secret))).toBe(true);
    });

    it('adopts a token another process already rotated instead of refreshing', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const rotated = makeJwt(900);
        seed(config, rotated, 'rt-2');
        expect(await store.refresh(stale)).toBe(rotated);
        expect(server.calls).toEqual([]);
    });

    it('never adopts or refreshes credentials that belong to another account', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        seed(config, makeJwt(30), 'rt-other', getRandomBytes(32));
        await expect(store.refresh(stale)).rejects.toThrow('different account');
        expect(server.calls).toEqual([]);
        expect(readCredentials(config)?.refreshToken).toBe('rt-other');
    });

    it('single-flights concurrent refreshes', async () => {
        let calls = 0;
        server = await startFakeServer({
            'POST /v1/auth/refresh': async () => {
                calls++;
                await new Promise((r) => setTimeout(r, 50));
                return { status: 200, body: { accessToken: makeJwt(900), refreshToken: `rt-${calls + 1}` } };
            },
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const results = await Promise.all([store.refresh(stale), store.refresh(stale), store.getAccessToken()]);
        expect(new Set(results).size).toBe(1);
        expect(calls).toBe(1);
    });

    it('clears the credentials and reports logged out on invalid_grant', async () => {
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 401, body: { error: 'invalid_grant', reason: 'revoked' } }),
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        await expect(store.refresh(stale)).rejects.toBeInstanceOf(LoggedOutError);
        expect(readCredentials(config)).toBeNull();
        await expect(store.getAccessToken()).rejects.toBeInstanceOf(LoggedOutError);
    });

    it('keeps a newer login when invalid_grant arrives for the old refresh token', async () => {
        let config!: Config;
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => {
                seed(config, makeJwt(900), 'rt-new-login');
                return { status: 401, body: { error: 'invalid_grant', reason: 'revoked' } };
            },
        });
        config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        await expect(store.refresh(stale)).rejects.toBeInstanceOf(LoggedOutError);
        expect(readCredentials(config)?.refreshToken).toBe('rt-new-login');
    });

    it('keeps credentials on network errors and never puts tokens in the error', async () => {
        const config = configFor('http://127.0.0.1:9');
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const error = await store.refresh(stale).catch((e: Error) => e) as Error;
        expect(error).not.toBeInstanceOf(LoggedOutError);
        expect(error.message).toMatch(/^Token refresh failed: /);
        expect(error.message).not.toContain('rt-1');
        expect(error.message).not.toContain(stale);
        expect(readCredentials(config)?.token).toBe(stale);
    });

    it('keeps a rotation in memory when the write fails, and persists it on the next refresh without burning a second token', async () => {
        let refreshCalls = 0;
        const next = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => {
                refreshCalls++;
                return { status: 200, body: { accessToken: next, refreshToken: 'rt-rotated' } };
            },
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));

        const writeSpy = vi.spyOn(credentialsModule, 'writeCredentials').mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        const firstToken = await store.getAccessToken();
        writeSpy.mockRestore();

        expect(firstToken).toBe(next);
        expect(refreshCalls).toBe(1);
        // Still unpersisted: the file has not caught up yet.
        expect(readCredentials(config)?.token).toBe(stale);

        // A second refresh (new process-local stale token, or another 401) must retry
        // persisting the pending rotation rather than asking the server for another one.
        const secondToken = await store.refresh(makeJwt(30));
        expect(secondToken).toBe(next);
        expect(refreshCalls).toBe(1);
        const stored = readCredentials(config)!;
        expect(stored.token).toBe(next);
        expect(stored.refreshToken).toBe('rt-rotated');
    });

    it('drops a pending rotation that no longer matches the file instead of clobbering a newer login', async () => {
        let refreshCalls = 0;
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => {
                refreshCalls++;
                return { status: 200, body: { accessToken: makeJwt(900), refreshToken: 'rt-rotated' } };
            },
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale)); // refreshToken rt-1

        const writeSpy = vi.spyOn(credentialsModule, 'writeCredentials').mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        await store.getAccessToken();
        writeSpy.mockRestore();
        expect(refreshCalls).toBe(1);

        // A concurrent process logs in fresh, replacing the file entirely (different refresh
        // token, same account). Our pendingRotation's `from` ('rt-1') no longer matches the
        // file, so persisting it would clobber the concurrent login — it must be dropped.
        const concurrentToken = makeJwt(900);
        writeCredentials(config, { token: concurrentToken, refreshToken: 'rt-concurrent-login', secret });

        const adopted = await store.refresh(makeJwt(30));
        expect(adopted).toBe(concurrentToken);
        expect(refreshCalls).toBe(1); // adopted directly (fresh); no extra server call
        const stored = readCredentials(config)!;
        expect(stored.refreshToken).toBe('rt-concurrent-login');
    });

    it('retries the refresh POST once immediately when the first attempt gets no response', async () => {
        const next = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: next, refreshToken: 'rt-2' } }),
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));

        const originalPost = axios.post.bind(axios);
        const postSpy = vi.spyOn(axios, 'post')
            .mockImplementationOnce(async () => {
                throw new AxiosError('socket hang up', 'ECONNRESET');
            })
            .mockImplementation(originalPost as typeof axios.post);

        const token = await store.getAccessToken();
        expect(token).toBe(next);
        expect(postSpy).toHaveBeenCalledTimes(2);
        const stored = readCredentials(config)!;
        expect(stored.token).toBe(next);
        postSpy.mockRestore();
    });

    it('gives up and sanitizes the error when both refresh attempts get no response', async () => {
        const config = configFor('http://127.0.0.1:9');
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));
        const postSpy = vi.spyOn(axios, 'post');

        const error = await store.refresh(stale).catch((e: Error) => e) as Error;
        expect(error).not.toBeInstanceOf(LoggedOutError);
        expect(error.message).toMatch(/^Token refresh failed: /);
        expect(postSpy).toHaveBeenCalledTimes(2);
        expect(readCredentials(config)?.token).toBe(stale);
        postSpy.mockRestore();
    });

    it('treats a malformed refresh response as a non-auth error and leaves the file untouched', async () => {
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: 12345, refreshToken: 'rt-2' } }),
        });
        const config = configFor(server.url);
        const stale = makeJwt(30);
        const store = new TokenStore(config, seed(config, stale));

        const error = await store.refresh(stale).catch((e: Error) => e) as Error;
        expect(error).not.toBeInstanceOf(LoggedOutError);
        expect(error.message).toMatch(/^Token refresh failed: /);
        expect(readCredentials(config)?.token).toBe(stale);
    });
});

describe('withAuthRetry', () => {
    const failure = (status: number) => new AxiosError('Request failed', String(status), undefined, undefined, { status } as never);
    const tokensFor = () => ({ getAccessToken: vi.fn(async () => 'old'), refresh: vi.fn(async () => 'new') });

    it('retries once with a refreshed token after a 401 from the configured server', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValueOnce(failure(401)).mockResolvedValueOnce('ok');
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test/v1/sessions', send)).resolves.toBe('ok');
        expect(tokens.refresh).toHaveBeenCalledWith('old');
        expect(send.mock.calls).toEqual([['old'], ['new']]);
    });

    it('gives up after the second 401', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValue(failure(401));
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test/v1/sessions', send)).rejects.toBeInstanceOf(AxiosError);
        expect(send).toHaveBeenCalledTimes(2);
        expect(tokens.refresh).toHaveBeenCalledTimes(1);
    });

    it('does not retry requests to another origin', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValue(failure(401));
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test:4443/v1/sessions', send)).rejects.toBeInstanceOf(AxiosError);
        expect(tokens.refresh).not.toHaveBeenCalled();
    });

    it('does not retry other failures', async () => {
        const tokens = tokensFor();
        const send = vi.fn().mockRejectedValue(failure(500));
        await expect(withAuthRetry(tokens, 'https://api.test', 'https://api.test/v1/sessions', send)).rejects.toBeInstanceOf(AxiosError);
        expect(tokens.refresh).not.toHaveBeenCalled();
    });
});

describe('socketAuth', () => {
    it('awaits a fresh token on every handshake', async () => {
        const tokens = { getAccessToken: vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2') };
        const auth = socketAuth(tokens, { clientType: 'session-scoped', sessionId: 's1' });
        const first = await new Promise((resolve) => auth(resolve));
        const second = await new Promise((resolve) => auth(resolve));
        expect(first).toEqual({ clientType: 'session-scoped', sessionId: 's1', token: 't1' });
        expect(second).toEqual({ clientType: 'session-scoped', sessionId: 's1', token: 't2' });
    });

    it('hands logged-out errors to onLoggedOut instead of completing the handshake', async () => {
        const onLoggedOut = vi.fn();
        const cb = vi.fn();
        socketAuth({ getAccessToken: () => Promise.reject(new LoggedOutError()) }, {}, onLoggedOut)(cb);
        await new Promise((r) => setTimeout(r, 0));
        expect(onLoggedOut).toHaveBeenCalledWith(expect.any(LoggedOutError));
        expect(cb).not.toHaveBeenCalled();
    });

    it('sends an empty token on other failures so the server rejects the handshake', async () => {
        const payload = await new Promise((resolve) => {
            socketAuth({ getAccessToken: () => Promise.reject(new Error('network')) }, { clientType: 'x' })(resolve);
        });
        expect(payload).toEqual({ clientType: 'x', token: '' });
    });

    it('never raises an unhandled rejection even if the handshake callback throws', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (err: unknown) => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);
        try {
            socketAuth({ getAccessToken: async () => 't1' }, {})(() => {
                throw new Error('consumer boom');
            });
            await new Promise((r) => setTimeout(r, 10));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toHaveLength(0);
    });

    it('never raises an unhandled rejection even if onLoggedOut throws', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (err: unknown) => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);
        try {
            socketAuth(
                { getAccessToken: () => Promise.reject(new LoggedOutError()) },
                {},
                () => { throw new Error('handler boom'); },
            )(() => {});
            await new Promise((r) => setTimeout(r, 10));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toHaveLength(0);
    });
});
