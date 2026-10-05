import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { setupAuthTest } from '@/testing/authTestKit';

import type { DeviceKind } from '@/app/auth/oidc/devices';

let db: PrismaClient;
let server: Server;
let base: string;
let calls: Array<{ user: { email: string | null; claims: unknown }; client: { kind: string } }> = [];
let answer: (body: { client: { kind: string } }) => { status: number; body: unknown } = () => ({ status: 200, body: { allowed: true } });
let authz: typeof import('./authz');
let devices: typeof import('@/app/auth/oidc/devices');

beforeAll(async () => {
    db = (await setupAuthTest()).db;
    server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw);
            calls.push(body);
            const { status, body: out } = answer(body);
            res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authz = await import('./authz');
    devices = await import('@/app/auth/oidc/devices');
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const env = (ttl = '60s') => ({
    AUTHZ_WEBHOOK_URL: `${base}/check`, AUTHZ_WEBHOOK_SECRET: 's', AUTHZ_WEBHOOK_ALLOW_INSECURE: 'true', AUTHZ_WEBHOOK_CACHE_TTL: ttl,
});

let n = 0;
async function device(kind: DeviceKind) {
    n++;
    const account = await db.account.create({
        data: { publicKey: `pk-authz-${n}`, oidcIssuer: 'https://idp.test', oidcSubject: `u${n}`, email: `u${n}@example.com`, firstName: 'U', lastName: `${n}`, idpClaims: { groups: ['g'], name: `User ${n}` } },
    });
    const d = await devices.createDevice({ accountId: account.id, kind, name: `${kind}-device` });
    return { accountId: account.id, deviceId: d.deviceId };
}

beforeEach(() => {
    calls = [];
    answer = () => ({ status: 200, body: { allowed: true } });
    authz.resetAuthzForTests();
});

describe('authorizeDevice', () => {
    it('allows everything and calls nothing when not configured', async () => {
        authz.initAuthz({});
        expect(authz.isAuthzEnabled()).toBe(false);
        expect(await authz.authorizeDevice((await device('web')).deviceId)).toEqual({ allowed: true });
        expect(calls).toEqual([]);
    });

    it('never checks cli devices', async () => {
        authz.initAuthz(env());
        answer = () => ({ status: 200, body: { allowed: false } });
        expect(await authz.authorizeDevice((await device('cli')).deviceId)).toEqual({ allowed: true });
        expect(calls).toEqual([]);
    });

    it.each(['web', 'mobile', 'agent'] as const)('asks the webhook for %s devices, with the user and claims', async (kind) => {
        authz.initAuthz(env());
        const d = await device(kind);
        answer = () => ({ status: 200, body: { allowed: false, reason: 'No access' } });
        expect(await authz.authorizeDevice(d.deviceId)).toEqual({ allowed: false, reason: 'No access' });
        expect(calls).toEqual([{
            user: { accountId: d.accountId, issuer: 'https://idp.test', subject: expect.any(String), email: expect.stringMatching(/@example\.com$/), name: expect.stringMatching(/^User /), claims: { groups: ['g'], name: expect.any(String) } },
            client: { kind, deviceName: `${kind}-device` },
        }]);
    });

    it('caches a decision per account and kind for the TTL', async () => {
        authz.initAuthz(env('60s'));
        const d = await device('web');
        await authz.authorizeDevice(d.deviceId);
        await authz.authorizeDevice(d.deviceId);
        expect(calls).toHaveLength(1);
    });

    it('shares one webhook call between concurrent requests', async () => {
        authz.initAuthz(env());
        const d = await device('web');
        await Promise.all([authz.authorizeDevice(d.deviceId), authz.authorizeDevice(d.deviceId), authz.authorizeDevice(d.deviceId)]);
        expect(calls).toHaveLength(1);
    });

    it('asks again after the TTL', async () => {
        authz.initAuthz(env('1s'));
        const d = await device('web');
        await authz.authorizeDevice(d.deviceId);
        await new Promise((r) => setTimeout(r, 1_100));
        await authz.authorizeDevice(d.deviceId);
        expect(calls).toHaveLength(2);
    });

    it('does not cache failures', async () => {
        authz.initAuthz(env());
        const d = await device('web');
        answer = () => ({ status: 500, body: {} });
        expect((await authz.authorizeDevice(d.deviceId)).allowed).toBe(false);
        answer = () => ({ status: 200, body: { allowed: true } });
        expect(await authz.authorizeDevice(d.deviceId)).toEqual({ allowed: true });
        expect(calls).toHaveLength(2);
    });

    it('denies an unknown device', async () => {
        authz.initAuthz(env());
        expect((await authz.authorizeDevice('no-such-device')).allowed).toBe(false);
    });
});

describe('forbiddenBody', () => {
    it('omits a missing reason', () => {
        expect(authz.forbiddenBody({ allowed: false, reason: null })).toEqual({ error: 'forbidden' });
        expect(authz.forbiddenBody({ allowed: false, reason: 'r' })).toEqual({ error: 'forbidden', reason: 'r' });
    });
});
