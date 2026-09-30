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
    });

    it('web: requires a code challenge', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/auth/oidc/login?client=web' });
        expect(res.statusCode).toBe(400);
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
});
