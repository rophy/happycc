import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from './config';
import { readCredentials, type StoredCredentials } from './credentials';
import { decodeBase64, encodeBase64, libsodiumEncryptForPublicKey } from './encryption';
import { LoginError, loopbackLogin } from './loopbackLogin';
import { startFakeServer } from './testing/fakeServer';

const LOGIN_URL = /(https?:\/\/\S+\/v1\/auth\/oidc\/login\?\S+)/;
const rootSecret = new Uint8Array(randomBytes(32));

let homeDir: string;
let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;

beforeEach(() => { homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-login-')); });
afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(homeDir, { recursive: true, force: true });
});

function configFor(serverUrl: string): Config {
    return { serverUrl, homeDir: join(homeDir, 'home'), credentialPath: join(homeDir, 'home', 'agent.key') };
}

async function startExchangeServer(status = 200) {
    server = await startFakeServer({
        'POST /v1/auth/oidc/exchange': (body) => status !== 200
            ? { status, body: { error: 'invalid_grant' } }
            : {
                status: 200,
                body: {
                    accountId: 'acc_1',
                    accessToken: 'access-token-1',
                    refreshToken: 'refresh-token-1',
                    keyBundle: encodeBase64(libsodiumEncryptForPublicKey(rootSecret, decodeBase64(body.ephemeralPublicKey))),
                },
            },
    });
    return server;
}

/** Runs loopbackLogin; `browser` receives the printed login URL and plays the browser's part. */
async function runLogin(config: Config, browser: (loginUrl: URL) => Promise<void>, timeoutMs?: number) {
    const lines: string[] = [];
    let browserRun: Promise<void> | null = null;
    let credentials: StoredCredentials | undefined;
    let error: Error | undefined;
    try {
        credentials = await loopbackLogin({
            config,
            deviceName: 'happycc-agent@test-host',
            timeoutMs,
            io: {
                print: (line) => {
                    lines.push(line);
                    const match = LOGIN_URL.exec(line);
                    if (match && !browserRun) {
                        browserRun = browser(new URL(match[1]));
                    }
                },
            },
        });
    } catch (e) {
        error = e as Error;
    }
    await browserRun;
    return { credentials, error, output: lines.join('\n') };
}

describe('loopbackLogin', () => {
    it('prints the login URL, receives the code on 127.0.0.1 and stores the credentials', async () => {
        const fake = await startExchangeServer();
        let challenge = '';
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe(`${fake.url}/v1/auth/oidc/login`);
            expect(loginUrl.searchParams.get('client')).toBe('loopback');
            challenge = loginUrl.searchParams.get('code_challenge')!;
            expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const redirectUri = loginUrl.searchParams.get('redirect_uri')!;
            expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
            const res = await fetch(`${redirectUri}?code=exchange-code-1`);
            expect(res.status).toBe(200);
            expect(await res.text()).toContain('You can close this tab');
        });
        if (result.error) throw result.error;

        const exchange = fake.calls.find((c) => c.path === '/v1/auth/oidc/exchange')!;
        expect(exchange.body.code).toBe('exchange-code-1');
        expect(exchange.body.deviceName).toBe('happycc-agent@test-host');
        expect(createHash('sha256').update(exchange.body.codeVerifier).digest('base64url')).toBe(challenge);

        const stored = readCredentials(configFor(fake.url))!;
        expect(stored.token).toBe('access-token-1');
        expect(stored.refreshToken).toBe('refresh-token-1');
        expect(Buffer.from(stored.secret).equals(Buffer.from(rootSecret))).toBe(true);
        expect(statSync(join(homeDir, 'home', 'agent.key')).mode & 0o777).toBe(0o600);
        expect(existsSync(join(homeDir, 'home', 'agent.key.lock'))).toBe(false);
        expect(result.output).not.toContain('access-token-1');
        expect(result.output).not.toContain('refresh-token-1');
    });

    it('answers other paths with 404 and keeps waiting', async () => {
        const fake = await startExchangeServer();
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            const redirect = new URL(loginUrl.searchParams.get('redirect_uri')!);
            expect((await fetch(`${redirect.origin}/favicon.ico`)).status).toBe(404);
            expect((await fetch(`${redirect.origin}/other?code=x`)).status).toBe(404);
            await fetch(`${redirect.href}?code=exchange-code-2`);
        });
        if (result.error) throw result.error;
        expect(fake.calls.find((c) => c.path === '/v1/auth/oidc/exchange')?.body.code).toBe('exchange-code-2');
    });

    it('fails when the browser returns an error', async () => {
        const fake = await startExchangeServer();
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            const res = await fetch(`${loginUrl.searchParams.get('redirect_uri')}?error=access_denied`);
            expect(res.status).toBe(400);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('cancelled or denied');
        expect(fake.calls).toEqual([]);
        expect(existsSync(join(homeDir, 'home', 'agent.key'))).toBe(false);
    });

    it('fails when the callback carries no code', async () => {
        const fake = await startExchangeServer();
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            const res = await fetch(loginUrl.searchParams.get('redirect_uri')!);
            expect(res.status).toBe(400);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('did not include a code');
        expect(fake.calls).toEqual([]);
    });

    it('times out and closes the listener', async () => {
        const fake = await startExchangeServer();
        let redirectUri = '';
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            redirectUri = loginUrl.searchParams.get('redirect_uri')!;
        }, 50);
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('timed out');
        await expect(fetch(`${redirectUri}?code=late`)).rejects.toThrow();
    });

    it('reports a rejected exchange without writing credentials', async () => {
        const fake = await startExchangeServer(400);
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            await fetch(`${loginUrl.searchParams.get('redirect_uri')}?code=stale`);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('400 invalid_grant');
        expect(existsSync(join(homeDir, 'home', 'agent.key'))).toBe(false);
    });

    it('says the server could not be reached when the exchange request fails outright', async () => {
        // Nothing is listening on this port, so axios never gets a response.
        const result = await runLogin(configFor('http://127.0.0.1:1'), async (loginUrl) => {
            await fetch(`${loginUrl.searchParams.get('redirect_uri')}?code=unreachable`);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('the server could not be reached');
    });

    it.each([
        ['accessToken', { accessToken: 123, refreshToken: 'r', keyBundle: 'k' }],
        ['refreshToken', { accessToken: 'a', refreshToken: null, keyBundle: 'k' }],
        ['keyBundle', { accessToken: 'a', refreshToken: 'r', keyBundle: 42 }],
    ])('rejects an exchange response with a non-string %s without writing credentials', async (_field, body) => {
        server = await startFakeServer({
            'POST /v1/auth/oidc/exchange': () => ({ status: 200, body: { accountId: 'acc_1', ...body } }),
        });
        const fake = server;
        const result = await runLogin(configFor(fake.url), async (loginUrl) => {
            await fetch(`${loginUrl.searchParams.get('redirect_uri')}?code=bad-shape`);
        });
        expect(result.error).toBeInstanceOf(LoginError);
        expect(result.error?.message).toContain('unexpected response');
        expect(existsSync(join(homeDir, 'home', 'agent.key'))).toBe(false);
    });
});
