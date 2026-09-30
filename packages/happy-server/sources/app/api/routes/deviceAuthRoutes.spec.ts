import { beforeAll, describe, expect, it } from 'vitest';
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

const clientInfo = { host: 'dev-42', os: 'linux', cliVersion: '1.2.5' };

beforeAll(async () => {
    ({ db, config, fake } = await setupAuthTest());
    keys = await import('@/app/auth/oidc/accountKeys');
    vault = await import('@/app/auth/oidc/keyVault');
    const { oidcRoutes } = await import('./oidcRoutes');
    const { deviceAuthRoutes } = await import('./deviceAuthRoutes');
    const deps = { config, oidc: fake.client, checkIdp: async () => true };
    app = await buildTestApp((a) => { oidcRoutes(a, deps); deviceAuthRoutes(a, deps); });
});

async function startFlow() {
    const ephemeral = tweetnacl.box.keyPair();
    const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/device/start',
        payload: { ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(ephemeral.publicKey)), clientInfo },
    });
    expect(res.statusCode).toBe(200);
    return { ephemeral, ...res.json() };
}

/** Browser: /activate → OIDC login → back to /activate with a session cookie. */
async function browserSession(userCode: string, subject: string) {
    const first = await app.inject({ method: 'GET', url: `/activate?code=${userCode}` });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`/v1/auth/oidc/login?client=activate&user_code=${userCode}`);
    fake.queueIdentity({ issuer: 'https://idp.test', subject, email: null, name: null, refreshToken: null });
    const login = await app.inject({ method: 'GET', url: first.headers.location as string });
    const state = new URL(login.headers.location as string).searchParams.get('state');
    const callback = await app.inject({
        method: 'GET',
        url: `/v1/auth/oidc/callback?code=c&state=${state}`,
        headers: { cookie: cookieHeader(login) },
    });
    return cookieHeader(callback);
}

function csrfFrom(html: string): string {
    return /name="csrf" value="([^"]+)"/.exec(html)![1];
}

function form(fields: Record<string, string>) {
    return { 'content-type': 'application/x-www-form-urlencoded', payload: new URLSearchParams(fields).toString() };
}

describe('deviceAuthRoutes', () => {
    it('full flow: start → activate → approve → token', async () => {
        const started = await startFlow();
        expect(started).toMatchObject({
            verifyUrl: `${config.publicUrl}/activate`,
            verifyUrlComplete: `${config.publicUrl}/activate?code=${started.userCode}`,
            interval: 5,
            expiresIn: 600,
        });

        const pending = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(pending.statusCode).toBe(400);
        expect(pending.json()).toEqual({ error: 'authorization_pending' });

        const cookie = await browserSession(started.userCode, 'd-alice');
        const confirm = await app.inject({ method: 'GET', url: `/activate?code=${started.userCode}`, headers: { cookie } });
        expect(confirm.statusCode).toBe(200);
        expect(confirm.body).toContain('dev-42');
        expect(confirm.body).toContain(started.userCode);
        expect(confirm.headers['x-frame-options']).toBe('DENY');
        expect(confirm.headers['content-security-policy']).toBe("frame-ancestors 'none'");

        const { payload, ...headers } = form({ code: started.userCode, csrf: csrfFrom(confirm.body), decision: 'approve' });
        const decided = await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        expect(decided.statusCode).toBe(200);
        expect(decided.body).toContain('Return to your terminal');

        await db.deviceAuthRequest.updateMany({ where: { userCode: started.userCode }, data: { lastPolledAt: null } });
        const token = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(token.statusCode).toBe(200);
        const body = token.json();

        const bundle = privacyKit.decodeBase64(body.keyBundle);
        const opened = tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), started.ephemeral.secretKey)!;
        const account = await db.account.findUniqueOrThrow({ where: { id: body.accountId } });
        const root = vault.keyVault.unwrap(account.wrappedRootSecret!);
        expect(Buffer.from(opened).equals(Buffer.from(keys.cliKeyBundlePlaintext(root)))).toBe(true);

        const device = await db.device.findFirstOrThrow({ where: { accountId: body.accountId, kind: 'cli' } });
        expect(device).toMatchObject({ name: 'dev-42', host: 'dev-42' });
    });

    it('maps denial and bad codes to RFC 8628 errors', async () => {
        const started = await startFlow();
        const cookie = await browserSession(started.userCode, 'd-bob');
        const confirm = await app.inject({ method: 'GET', url: `/activate?code=${started.userCode}`, headers: { cookie } });
        const { payload, ...headers } = form({ code: started.userCode, csrf: csrfFrom(confirm.body), decision: 'deny' });
        await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        const denied = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(denied.json()).toEqual({ error: 'access_denied' });

        const unknown = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: 'nope' } });
        expect(unknown.json()).toEqual({ error: 'invalid_grant' });
    });

    it('refuses to issue tokens for disabled accounts', async () => {
        const started = await startFlow();
        const cookie = await browserSession(started.userCode, 'd-disabled');
        const confirm = await app.inject({ method: 'GET', url: `/activate?code=${started.userCode}`, headers: { cookie } });
        const { payload, ...headers } = form({ code: started.userCode, csrf: csrfFrom(confirm.body), decision: 'approve' });
        await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        await db.account.updateMany({ where: { oidcSubject: 'd-disabled' }, data: { disabledAt: new Date() } });

        const token = await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
        expect(token.statusCode).toBe(400);
        expect(token.json()).toEqual({ error: 'invalid_grant' });
        const deviceCount = await db.device.count({ where: { kind: 'cli' } });
        const account = await db.account.findFirstOrThrow({ where: { oidcSubject: 'd-disabled' } });
        expect(await db.device.count({ where: { accountId: account.id, kind: 'cli' } })).toBe(0);
        void deviceCount;
    });

    it('rejects a decision with a CSRF token for another code', async () => {
        const a = await startFlow();
        const b = await startFlow();
        const cookie = await browserSession(a.userCode, 'd-carol');
        const confirmA = await app.inject({ method: 'GET', url: `/activate?code=${a.userCode}`, headers: { cookie } });
        const { payload, ...headers } = form({ code: b.userCode, csrf: csrfFrom(confirmA.body), decision: 'approve' });
        const res = await app.inject({ method: 'POST', url: '/activate', headers: { ...headers, cookie }, payload });
        expect(res.statusCode).toBe(403);
    });

    it('rejects a decision without a browser session', async () => {
        const started = await startFlow();
        const { payload, ...headers } = form({ code: started.userCode, csrf: 'x', decision: 'approve' });
        const res = await app.inject({ method: 'POST', url: '/activate', headers, payload });
        expect(res.statusCode).toBe(401);
    });

    it('shows the code entry page for unknown codes', async () => {
        const cookie = await browserSession('ZZZZ-ZZZZ', 'd-dave');
        const res = await app.inject({ method: 'GET', url: '/activate?code=ZZZZ-ZZZZ', headers: { cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('not found or expired');
    });

    it('rejects malformed ephemeral keys', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/auth/device/start',
            payload: { ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(8)), clientInfo },
        });
        expect(res.statusCode).toBe(400);
    });
});
