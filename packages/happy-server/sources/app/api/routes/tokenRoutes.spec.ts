import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '../types';
import { buildTestApp, setupAuthTest } from '@/testing/authTestKit';

let db: PrismaClient;
let app: Fastify;
let devices: typeof import('@/app/auth/oidc/devices');
let idpAllowed = true;

beforeAll(async () => {
    const setup = await setupAuthTest();
    db = setup.db;
    devices = await import('@/app/auth/oidc/devices');
    const { tokenRoutes } = await import('./tokenRoutes');
    app = await buildTestApp((a) => {
        a.get('/whoami', { preHandler: a.authenticate }, async (request) => ({ userId: request.userId, deviceId: request.deviceId }));
        tokenRoutes(a, { config: setup.config, oidc: setup.fake.client, checkIdp: async () => idpAllowed });
    });
});

let n = 0;
async function newDevice() {
    n++;
    const account = await db.account.create({ data: { publicKey: `pk-token-${n}` } });
    return { accountId: account.id, ...(await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' })) };
}

describe('tokenRoutes', () => {
    it('refreshes tokens', async () => {
        const d = await newDevice();
        const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: d.refreshToken } });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const who = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${body.accessToken}` } });
        expect(who.json()).toEqual({ userId: d.accountId, deviceId: d.deviceId });
    });

    it('returns 401 invalid_grant with a reason', async () => {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'nope' } });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'invalid_grant', reason: 'invalid' });
    });

    it('applies the IdP check', async () => {
        const d = await newDevice();
        idpAllowed = false;
        try {
            const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: d.refreshToken } });
            expect(res.json()).toEqual({ error: 'invalid_grant', reason: 'disabled' });
        } finally {
            idpAllowed = true;
        }
    });

    it('logout revokes the calling device', async () => {
        const d = await newDevice();
        const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${d.accessToken}` } });
        expect(res.statusCode).toBe(200);
        const refresh = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: d.refreshToken } });
        expect(refresh.json()).toEqual({ error: 'invalid_grant', reason: 'revoked' });
    });

    it('logout requires authentication', async () => {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
        expect(res.statusCode).toBe(401);
    });
});
