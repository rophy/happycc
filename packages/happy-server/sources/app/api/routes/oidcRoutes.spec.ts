import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, cookieHeader, setupAuthTest, type FakeOidc } from '@/testing/authTestKit';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';

let db: PrismaClient;
let config: AuthConfig;
let fake: FakeOidc;
let app: Fastify;
let keys: typeof import('@/app/auth/oidc/accountKeys');
let vault: typeof import('@/app/auth/oidc/keyVault');

beforeAll(async () => {
    ({ db, config, fake } = await setupAuthTest());
    keys = await import('@/app/auth/oidc/accountKeys');
    vault = await import('@/app/auth/oidc/keyVault');
    const { oidcRoutes } = await import('./oidcRoutes');
    app = await buildTestApp((a) => oidcRoutes(a, { config, oidc: fake.client, checkIdp: async () => true }));
});

function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function login(query: string, subject: string) {
    fake.queueIdentity({ issuer: 'https://idp.test', subject, email: `${subject}@example.com`, name: 'Alice Example', refreshToken: null });
    const start = await app.inject({ method: 'GET', url: `/v1/auth/oidc/login?${query}` });
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state');
    return app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/callback?code=idp-code&state=${state}`,
        headers: { cookie: cookieHeader(start) },
    });
}

function csrfFrom(html: string): string {
    return /name="csrf" value="([^"]+)"/.exec(html)![1];
}

function form(fields: Record<string, string>) {
    return { 'content-type': 'application/x-www-form-urlencoded', payload: new URLSearchParams(fields).toString() };
}

/** Full loopback flow through the confirm gate: login → callback → GET confirm page → POST decision. */
async function loopbackConfirm(query: string, subject: string, decision: 'allow' | 'deny') {
    const callback = await login(query, subject);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/v1/auth/oidc/loopback/confirm');
    const cookie = cookieHeader(callback);
    const confirmPageRes = await app.inject({ method: 'GET', url: '/v1/auth/oidc/loopback/confirm', headers: { cookie } });
    expect(confirmPageRes.statusCode).toBe(200);
    const { payload, ...headers } = form({ csrf: csrfFrom(confirmPageRes.body), decision });
    return app.inject({ method: 'POST', url: '/v1/auth/oidc/loopback/confirm', headers: { ...headers, cookie }, payload });
}

describe('oidcRoutes', () => {
    it('web: login → callback → exchange yields tokens and the root secret', async () => {
        const { verifier, challenge } = pkce();
        const callback = await login(`client=web&code_challenge=${challenge}`, 'r-web');
        expect(callback.statusCode).toBe(302);
        const location = callback.headers.location as string;
        expect(location.startsWith(`${config.webappUrl}/auth/callback#code=`)).toBe(true);
        const code = new URLSearchParams(location.split('#')[1]).get('code')!;

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)) },
        });
        expect(exchange.statusCode).toBe(200);
        const body = exchange.json();
        expect(body).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), accountId: expect.any(String) });

        const bundle = privacyKit.decodeBase64(body.keyBundle);
        const root = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), ephemeral.secretKey)!;
        const account = await db.account.findUniqueOrThrow({ where: { id: body.accountId } });
        expect(Buffer.from(root).equals(Buffer.from(vault.keyVault.unwrap(account.wrappedRootSecret!)))).toBe(true);
        expect(account.publicKey).toBe(keys.deriveAccountPublicKeyHex(root));
        const device = await db.device.findFirstOrThrow({ where: { accountId: body.accountId } });
        expect(device.kind).toBe('web');

        const replay = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)) },
        });
        expect(replay.statusCode).toBe(400);
        expect(replay.json()).toEqual({ error: 'invalid_grant' });
    });

    it('refuses to issue tokens for a disabled account at exchange time', async () => {
        const { verifier, challenge } = pkce();
        const callback = await login(`client=web&code_challenge=${challenge}`, 'r-exchange-disabled');
        const code = new URLSearchParams((callback.headers.location as string).split('#')[1]).get('code')!;
        await db.account.updateMany({ where: { oidcSubject: 'r-exchange-disabled' }, data: { disabledAt: new Date() } });

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: verifier, ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)) },
        });
        expect(exchange.statusCode).toBe(400);
        expect(exchange.json()).toEqual({ error: 'invalid_grant' });
        const account = await db.account.findFirstOrThrow({ where: { oidcSubject: 'r-exchange-disabled' } });
        expect(await db.device.count({ where: { accountId: account.id } })).toBe(0);
    });

    it('rejects an exchange with the wrong PKCE verifier', async () => {
        const { challenge } = pkce();
        const callback = await login(`client=web&code_challenge=${challenge}`, 'r-wrong-verifier');
        const code = new URLSearchParams((callback.headers.location as string).split('#')[1]).get('code')!;
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code, codeVerifier: pkce().verifier, ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(32)) },
        });
        expect(exchange.statusCode).toBe(400);
    });

    it('rejects a malformed ephemeral key', async () => {
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: { code: 'x', codeVerifier: 'y', ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(16)) },
        });
        expect(exchange.statusCode).toBe(400);
    });

    it('mobile: redirects to an allowed custom scheme with the code', async () => {
        const { challenge } = pkce();
        const callback = await login(
            `client=mobile&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('corpapp://auth/callback')}`,
            'r-mobile',
        );
        expect(callback.statusCode).toBe(302);
        expect((callback.headers.location as string)).toMatch(/^corpapp:\/\/auth\/callback\?code=/);
    });

    it('mobile: rejects redirect URIs that are not configured', async () => {
        const { challenge } = pkce();
        const res = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/login?client=mobile&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('evil://steal')}`,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'redirect_uri is not allowed' });
    });

    it('web: requires a code challenge', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?client=web' });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'code_challenge is required' });
    });

    it('activate: sets a browser session and returns to /activate', async () => {
        const callback = await login('client=activate&user_code=BCDF-GHJK', 'r-activate');
        expect(callback.statusCode).toBe(302);
        expect(callback.headers.location).toBe('/activate?code=BCDF-GHJK');
        expect(cookieHeader(callback)).toContain('happy_session=');
    });

    it('rejects a callback without the login cookie', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/callback?code=x&state=y' });
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['x-frame-options']).toBe('DENY');
        expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    });

    it('does not forward IdP errors', async () => {
        const start = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?client=activate' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/oidc/callback?error=access_denied&error_description=%3Cscript%3E',
            headers: { cookie: cookieHeader(start) },
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).not.toContain('<script>');
    });

    it('refuses disabled accounts', async () => {
        const { challenge } = pkce();
        await login(`client=web&code_challenge=${challenge}`, 'r-disabled');
        await db.account.updateMany({ where: { oidcSubject: 'r-disabled' }, data: { disabledAt: new Date() } });
        const again = await login(`client=web&code_challenge=${challenge}`, 'r-disabled');
        expect(again.statusCode).toBe(403);
    });

    it('responds 503 while the IdP has not been discovered', async () => {
        fake.setReady(false);
        try {
            const { challenge } = pkce();
            const loginRes = await app.inject({ method: 'GET', url: `/v1/auth/oidc/login?client=web&code_challenge=${challenge}` });
            expect(loginRes.statusCode).toBe(503);
            expect(loginRes.json()).toEqual({ error: 'idp_unavailable' });

            const callback = await app.inject({ method: 'GET', url: '/v1/auth/oidc/callback?code=x&state=y' });
            expect(callback.statusCode).toBe(503);
            expect(callback.headers['content-type']).toContain('text/html');
        } finally {
            fake.setReady(true);
        }
    });

    it('passes the full callback query to the IdP client, including a literal ?', async () => {
        const start = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?client=activate' });
        const state = new URL(start.headers.location as string).searchParams.get('state');
        fake.queueIdentity({ issuer: 'https://idp.test', subject: 'r-query', email: null, name: null, refreshToken: null });
        const res = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/callback?code=abc?def&state=${state}`,
            headers: { cookie: cookieHeader(start) },
        });
        expect(res.statusCode).toBe(302);
        expect(fake.lastCallbackUrl?.searchParams.get('code')).toBe('abc?def');
        expect(fake.lastCallbackUrl?.searchParams.get('state')).toBe(state);
    });

    it('loopback: redirects to the agent listener and records an agent device holding the root secret', async () => {
        const { verifier, challenge } = pkce();
        const redirectUri = 'http://127.0.0.1:53682/callback';
        const decided = await loopbackConfirm(
            `client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            'r-loopback',
            'allow',
        );
        expect(decided.statusCode).toBe(302);
        const location = new URL(decided.headers.location as string);
        expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
        expect([...location.searchParams.keys()]).toEqual(['code']);
        const code = location.searchParams.get('code')!;

        const ephemeral = tweetnacl.box.keyPair();
        const exchange = await app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: {
                code,
                codeVerifier: verifier,
                ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)),
                deviceName: 'happy-agent@build-host',
            },
        });
        expect(exchange.statusCode).toBe(200);
        const body = exchange.json();
        const bundle = privacyKit.decodeBase64(body.keyBundle);
        const root = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), ephemeral.secretKey)!;
        const account = await db.account.findUniqueOrThrow({ where: { id: body.accountId } });
        expect(Buffer.from(root).equals(Buffer.from(vault.keyVault.unwrap(account.wrappedRootSecret!)))).toBe(true);
        const device = await db.device.findFirstOrThrow({ where: { accountId: body.accountId } });
        expect(device.kind).toBe('agent');
        expect(device.name).toBe('happy-agent@build-host');
    });

    it('loopback: accepts the IPv6 loopback literal', async () => {
        const { challenge } = pkce();
        const decided = await loopbackConfirm(
            `client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent('http://[::1]:8123/callback')}`,
            'r-loopback-v6',
            'allow',
        );
        expect(decided.statusCode).toBe(302);
        expect(decided.headers.location as string).toMatch(/^http:\/\/\[::1\]:8123\/callback\?code=/);
    });

    it('loopback: issues no code until the confirm page is submitted', async () => {
        const { challenge } = pkce();
        const redirectUri = 'http://127.0.0.1:53683/callback';
        const callback = await login(`client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`, 'r-loopback-pending');
        expect(callback.statusCode).toBe(302);
        expect(callback.headers.location).toBe('/v1/auth/oidc/loopback/confirm');
        const confirmPageRes = await app.inject({ method: 'GET', url: '/v1/auth/oidc/loopback/confirm', headers: { cookie: cookieHeader(callback) } });
        expect(confirmPageRes.statusCode).toBe(200);
        expect(confirmPageRes.body).toContain('53683');
        expect(confirmPageRes.body).not.toContain('code=');
    });

    it('loopback: rejects a confirm decision with an invalid CSRF token', async () => {
        const { challenge } = pkce();
        const redirectUri = 'http://127.0.0.1:53684/callback';
        const callback = await login(`client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`, 'r-loopback-badcsrf');
        const cookie = cookieHeader(callback);
        const { payload, ...headers } = form({ csrf: 'not-a-valid-token', decision: 'allow' });
        const res = await app.inject({ method: 'POST', url: '/v1/auth/oidc/loopback/confirm', headers: { ...headers, cookie }, payload });
        expect(res.statusCode).toBe(403);
    });

    it('loopback: rejects a confirm decision without the pending cookie', async () => {
        const { payload, ...headers } = form({ csrf: 'whatever', decision: 'allow' });
        const res = await app.inject({ method: 'POST', url: '/v1/auth/oidc/loopback/confirm', headers, payload });
        expect(res.statusCode).toBe(401);
    });

    it('loopback: deny redirects with error=access_denied and issues no code', async () => {
        const { challenge } = pkce();
        const redirectUri = 'http://127.0.0.1:53685/callback';
        const decided = await loopbackConfirm(
            `client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            'r-loopback-deny',
            'deny',
        );
        expect(decided.statusCode).toBe(302);
        expect(decided.headers.location).toBe(`${redirectUri}?error=access_denied`);
    });

    it.each([
        'http://localhost:53682/callback',
        'https://127.0.0.1:53682/callback',
        'http://127.0.0.1:53682/other',
        'http://127.0.0.1:53682/callback?x=1',
        'http://127.0.0.1:0/callback',
        'corpapp://auth/callback',
    ])('loopback: rejects redirect_uri %s', async (uri) => {
        const { challenge } = pkce();
        const res = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/login?client=loopback&code_challenge=${challenge}&redirect_uri=${encodeURIComponent(uri)}`,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'redirect_uri is not allowed' });
    });

    it('loopback: requires a redirect_uri and a code challenge', async () => {
        const { challenge } = pkce();
        const noRedirect = await app.inject({ method: 'GET', url: `/v1/auth/oidc/login?client=loopback&code_challenge=${challenge}` });
        expect(noRedirect.statusCode).toBe(400);
        expect(noRedirect.json()).toEqual({ error: 'redirect_uri is not allowed' });
        const noChallenge = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/login?client=loopback&redirect_uri=${encodeURIComponent('http://127.0.0.1:53682/callback')}`,
        });
        expect(noChallenge.statusCode).toBe(400);
        expect(noChallenge.json()).toEqual({ error: 'code_challenge is required' });
    });
});
