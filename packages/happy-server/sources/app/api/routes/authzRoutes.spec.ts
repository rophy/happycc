import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, cookieHeader, setupAuthTest, type FakeOidc } from '@/testing/authTestKit';

let db: PrismaClient;
let app: Fastify;
let fake: FakeOidc;
let server: Server;
let allowed = true;
let calls = 0;
let authz: typeof import('@/app/auth/authz/authz');
let devices: typeof import('@/app/auth/oidc/devices');

beforeAll(async () => {
    let config;
    ({ db, config, fake } = await setupAuthTest());
    server = createServer((_req, res) => {
        calls++;
        res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(allowed ? { allowed: true } : { allowed: false, reason: 'Ask IT' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    authz = await import('@/app/auth/authz/authz');
    devices = await import('@/app/auth/oidc/devices');
    authz.initAuthz({
        AUTHZ_WEBHOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`,
        AUTHZ_WEBHOOK_SECRET: 's', AUTHZ_WEBHOOK_ALLOW_INSECURE: 'true', AUTHZ_WEBHOOK_CACHE_TTL: '1s',
    });
    const { oidcRoutes } = await import('./oidcRoutes');
    const { tokenRoutes } = await import('./tokenRoutes');
    app = await buildTestApp((a) => {
        a.get('/whoami', { preHandler: a.authenticate }, async (request) => ({ userId: request.userId }));
        tokenRoutes(a, { config, oidc: fake.client, checkIdp: async () => true });
        oidcRoutes(a, { config, oidc: fake.client, checkIdp: async () => true });
    });
});
afterAll(async () => {
    authz.resetAuthzForTests();
    await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { allowed = true; calls = 0; });

let n = 0;
async function device(kind: import('@/app/auth/oidc/devices').DeviceKind) {
    n++;
    const account = await db.account.create({ data: { publicKey: `pk-authz-route-${n}`, oidcSubject: `r${n}` } });
    return devices.createDevice({ accountId: account.id, kind, name: kind });
}
const whoami = (token: string) => app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${token}` } });

describe('authenticated routes', () => {
    it.each(['web', 'mobile', 'agent'] as const)('refuse a denied %s device with the reason', async (kind) => {
        const d = await device(kind);
        allowed = false;
        const res = await whoami(d.accessToken);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', reason: 'Ask IT' });
    });

    it('let an allowed device through', async () => {
        const d = await device('web');
        expect((await whoami(d.accessToken)).statusCode).toBe(200);
    });

    it('never check a cli device', async () => {
        const d = await device('cli');
        allowed = false;
        expect((await whoami(d.accessToken)).statusCode).toBe(200);
        expect(calls).toBe(0);
    });
});

describe('logout', () => {
    it('still works for a denied device and revokes it', async () => {
        const d = await device('web');
        allowed = false;
        const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${d.accessToken}` } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: true });
        expect(calls).toBe(0);
    });
});

describe('oidc exchange', () => {
    async function webCode(subject: string) {
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        fake.queueIdentity({ issuer: 'https://idp.test', subject, email: `${subject}@example.com`, name: 'Alice Example', refreshToken: null });
        const start = await app.inject({ method: 'GET', url: `/v1/auth/oidc/login?client=web&code_challenge=${challenge}` });
        const state = new URL(start.headers.location as string).searchParams.get('state');
        const callback = await app.inject({
            method: 'GET',
            url: `/v1/auth/oidc/callback?code=idp-code&state=${state}`,
            headers: { cookie: cookieHeader(start) },
        });
        const code = new URLSearchParams((callback.headers.location as string).split('#')[1]).get('code')!;
        return { code, verifier };
    }
    const exchange = ({ code, verifier }: { code: string; verifier: string }) =>
        app.inject({
            method: 'POST',
            url: '/v1/auth/oidc/exchange',
            payload: {
                code,
                codeVerifier: verifier,
                ephemeralPublicKey: privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair().publicKey)),
            },
        });

    it('refuses a denied sign-in without creating a device', async () => {
        const c = await webCode('x-denied');
        const account = await db.account.findFirstOrThrow({ where: { oidcSubject: 'x-denied' } });
        const before = await db.device.count({ where: { accountId: account.id } });
        allowed = false;
        const res = await exchange(c);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', reason: 'Ask IT' });
        expect(await db.device.count({ where: { accountId: account.id } })).toBe(before);
    });

    it('lets an allowed sign-in through', async () => {
        const res = await exchange(await webCode('x-allowed'));
        expect(res.statusCode).toBe(200);
    });
});
