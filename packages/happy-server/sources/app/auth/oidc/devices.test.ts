import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';

let db: PrismaClient;
let devices: typeof import('./devices');
let tokens: typeof import('./accessTokens');

const MAX_AGE = 30 * 86400;

beforeAll(async () => {
    db = await createTestDb();
    tokens = await import('./accessTokens');
    tokens.initAccessTokens({ masterSecret: 'test-master-secret-that-is-long-enough-000', ttlSec: 900 });
    devices = await import('./devices');
});

let counter = 0;
async function newAccount(data: { disabledAt?: Date } = {}) {
    counter++;
    return db.account.create({ data: { publicKey: `pk-devices-${counter}`, ...data } });
}

describe('devices', () => {
    it('creates a device with working tokens', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'dev-42', host: 'dev-42' });
        expect(tokens.verifyAccessToken(created.accessToken)).toEqual({ userId: account.id, deviceId: created.deviceId });
        const row = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
        expect(row.refreshTokenHash).toBe(tokens.hashToken(created.refreshToken));
        expect(row.kind).toBe('cli');
    });

    it('rotates refresh tokens', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'web' });
        const result = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tokens.refreshToken).not.toBe(created.refreshToken);
        expect(tokens.verifyAccessToken(result.tokens.accessToken)?.deviceId).toBe(created.deviceId);
    });

    it('revokes the device when a rotated token is reused', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'web' });
        const first = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(first.ok).toBe(true);
        const reuse = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(reuse).toEqual({ ok: false, reason: 'reused' });
        if (!first.ok) return;
        const afterReuse = await devices.refreshDevice(first.tokens.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(afterReuse).toEqual({ ok: false, reason: 'revoked' });
    });

    it('revokes the device when a token two rotations old is reused', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'web' });
        const first = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = await devices.refreshDevice(first.tokens.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        const replay = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(replay).toEqual({ ok: false, reason: 'reused' });

        const afterReuse = await devices.refreshDevice(second.tokens.refreshToken, { maxSessionAgeSec: MAX_AGE });
        expect(afterReuse).toEqual({ ok: false, reason: 'revoked' });
    });

    it('rejects unknown tokens', async () => {
        expect(await devices.refreshDevice('nope', { maxSessionAgeSec: MAX_AGE })).toEqual({ ok: false, reason: 'invalid' });
    });

    it('rejects revoked devices', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
        await devices.revokeDevice(created.deviceId);
        expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE }))
            .toEqual({ ok: false, reason: 'revoked' });
    });

    it('rejects disabled accounts', async () => {
        const account = await newAccount({ disabledAt: new Date() });
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
        expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE }))
            .toEqual({ ok: false, reason: 'disabled' });
    });

    it('expires sessions older than the max age', async () => {
        const account = await newAccount();
        const start = new Date('2026-01-01T00:00:00Z');
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x', now: start });
        const later = new Date(start.getTime() + (MAX_AGE + 1) * 1000);
        expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE, now: later }))
            .toEqual({ ok: false, reason: 'expired' });
        const row = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
        expect(row.revokedAt).not.toBeNull();
    });

    it('rejects when the IdP check fails', async () => {
        const account = await newAccount();
        const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
        const result = await devices.refreshDevice(created.refreshToken, {
            maxSessionAgeSec: MAX_AGE,
            checkIdp: async (accountId) => accountId !== account.id,
        });
        expect(result).toEqual({ ok: false, reason: 'disabled' });
    });

    it('revokes all devices of an account', async () => {
        const account = await newAccount();
        const a = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'a' });
        const b = await devices.createDevice({ accountId: account.id, kind: 'web', name: 'b' });
        await devices.revokeAccountDevices(account.id);
        for (const d of [a, b]) {
            expect(await devices.refreshDevice(d.refreshToken, { maxSessionAgeSec: MAX_AGE }))
                .toEqual({ ok: false, reason: 'revoked' });
        }
    });
});
