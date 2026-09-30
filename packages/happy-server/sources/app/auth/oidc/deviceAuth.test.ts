import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';

let db: PrismaClient;
let flow: typeof import('./deviceAuth');
let accountId: string;
const clientInfo = { host: 'dev-42', os: 'linux', cliVersion: '1.2.5' };

beforeAll(async () => {
    db = await createTestDb();
    flow = await import('./deviceAuth');
    accountId = (await db.account.create({ data: { publicKey: 'pk-device-auth' } })).id;
});

describe('user codes', () => {
    it('uses the unambiguous alphabet in XXXX-XXXX form', () => {
        for (let i = 0; i < 50; i++) {
            expect(flow.generateUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
        }
    });

    it('normalizes user input', () => {
        expect(flow.normalizeUserCode(' bcdf ghjk ')).toBe('BCDF-GHJK');
        expect(flow.normalizeUserCode('bcdf-ghjk')).toBe('BCDF-GHJK');
        expect(flow.normalizeUserCode('bcd')).toBeNull();
    });
});

describe('device flow', () => {
    it('pending → approved → consumed', async () => {
        const { deviceCode, userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const t0 = new Date();
        expect(await flow.pollDeviceAuth(deviceCode, t0)).toEqual({ status: 'pending' });
        expect(await flow.findPendingRequest(userCode)).toEqual({ userCode, clientInfo });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'approve')).toBe(true);
        const t1 = new Date(t0.getTime() + 6000);
        expect(await flow.pollDeviceAuth(deviceCode, t1)).toEqual({ status: 'approved', accountId, ephemeralPublicKey: 'eph', clientInfo });
        const t2 = new Date(t1.getTime() + 6000);
        expect(await flow.pollDeviceAuth(deviceCode, t2)).toEqual({ status: 'invalid' });
    });

    it('asks fast pollers to slow down', async () => {
        const { deviceCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const t0 = new Date();
        expect((await flow.pollDeviceAuth(deviceCode, t0)).status).toBe('pending');
        expect((await flow.pollDeviceAuth(deviceCode, new Date(t0.getTime() + 1000))).status).toBe('slow_down');
    });

    it('tolerates up to 1 s of polling jitter', async () => {
        const { deviceCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const t0 = new Date();
        expect((await flow.pollDeviceAuth(deviceCode, t0)).status).toBe('pending');
        expect((await flow.pollDeviceAuth(deviceCode, new Date(t0.getTime() + 4500))).status).toBe('pending');
    });

    it('reports denial', async () => {
        const { deviceCode, userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'deny')).toBe(true);
        expect((await flow.pollDeviceAuth(deviceCode)).status).toBe('denied');
    });

    it('can only be decided once', async () => {
        const { userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'approve')).toBe(true);
        expect(await flow.decideDeviceAuth(userCode, accountId, 'deny')).toBe(false);
        expect(await flow.findPendingRequest(userCode)).toBeNull();
    });

    it('expires after the TTL', async () => {
        const { deviceCode, userCode } = await flow.startDeviceAuth({ ephemeralPublicKey: 'eph', clientInfo });
        const later = new Date(Date.now() + (flow.DEVICE_CODE_TTL_SEC + 1) * 1000);
        expect((await flow.pollDeviceAuth(deviceCode, later)).status).toBe('expired');
        await db.deviceAuthRequest.updateMany({ where: { userCode }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect(await flow.decideDeviceAuth(userCode, accountId, 'approve')).toBe(false);
    });

    it('rejects unknown device codes', async () => {
        expect((await flow.pollDeviceAuth('unknown')).status).toBe('invalid');
    });
});
