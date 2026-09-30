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
        expect(tokens.verifyAccessToken(created.accessToken)).toEqual({ userId: account.id, deviceId: created.deviceId, expiresAt: expect.any(Number) });
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

    describe('reuse grace window', () => {
        const GRACE = { maxSessionAgeSec: MAX_AGE, reuseGraceSec: 60 };
        const base = Date.now() + 60_000;
        const at = (ms: number) => new Date(base + ms);

        it('re-rotates when the immediately previous token is replayed within the window', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            if (!first.ok) return;

            // The client never received `first` (lost response) and retries with the old token.
            // CLI timings: 10 s request timeout, then a 30 s retry delay.
            const retry = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(40_000) });
            expect(retry.ok).toBe(true);
            if (!retry.ok) return;
            expect(retry.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
            expect(tokens.verifyAccessToken(retry.tokens.accessToken)?.deviceId).toBe(created.deviceId);

            const next = await devices.refreshDevice(retry.tokens.refreshToken, { ...GRACE, now: at(50_000) });
            expect(next.ok).toBe(true);
        });

        it('revokes when the previous token is replayed after the window', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            if (!first.ok) return;

            const late = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(61_000) });
            expect(late).toEqual({ ok: false, reason: 'reused' });
            expect(await devices.refreshDevice(first.tokens.refreshToken, { ...GRACE, now: at(62_000) }))
                .toEqual({ ok: false, reason: 'revoked' });
        });

        it('revokes when a token older than the previous one is replayed within the window', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            if (!first.ok) return;
            const second = await devices.refreshDevice(first.tokens.refreshToken, { ...GRACE, now: at(1_000) });
            expect(second.ok).toBe(true);
            if (!second.ok) return;

            expect(await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(2_000) }))
                .toEqual({ ok: false, reason: 'reused' });
            expect(await devices.refreshDevice(second.tokens.refreshToken, { ...GRACE, now: at(3_000) }))
                .toEqual({ ok: false, reason: 'revoked' });
        });

        it('allows the grace replay only once', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            const retry = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000) });
            expect(retry.ok).toBe(true);

            expect(await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(2_000) }))
                .toEqual({ ok: false, reason: 'reused' });
        });

        it('does not extend the window to the pair issued by the lost response', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            if (!first.ok) return;
            const retry = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000) });
            expect(retry.ok).toBe(true);
            if (!retry.ok) return;

            // Someone else holding the lost pair shows up: the chain has forked.
            expect(await devices.refreshDevice(first.tokens.refreshToken, { ...GRACE, now: at(2_000) }))
                .toEqual({ ok: false, reason: 'reused' });
            expect(await devices.refreshDevice(retry.tokens.refreshToken, { ...GRACE, now: at(3_000) }))
                .toEqual({ ok: false, reason: 'revoked' });
        });

        it('revokes when a grace replay races the holder of the new token', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            if (!first.ok) return;

            const results = await Promise.all([
                devices.refreshDevice(first.tokens.refreshToken, { ...GRACE, now: at(1_000) }),
                devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000) }),
            ]);
            // Whatever the interleaving, the fork is detected and the device ends up revoked.
            expect(results.some((r) => !r.ok)).toBe(true);
            const device = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
            expect(device.revokedAt).not.toBeNull();
        });

        it('lets only one of two concurrent grace replays through and revokes', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);

            const results = await Promise.all([
                devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000) }),
                devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000) }),
            ]);
            expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
            const device = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
            expect(device.revokedAt).not.toBeNull();
        });

        it('treats a retry racing the still-running original as a lost-response retry', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });

            const [a, b] = await Promise.all([
                devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) }),
                devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) }),
            ]);
            expect(a.ok && b.ok).toBe(true);
            if (!a.ok || !b.ok) return;
            const device = await db.device.findUniqueOrThrow({ where: { id: created.deviceId } });
            expect(device.revokedAt).toBeNull();

            // Exactly one of the two pairs survives; presenting the other one later is a fork.
            const outcomes = await Promise.all([
                devices.refreshDevice(a.tokens.refreshToken, { ...GRACE, now: at(1_000) }),
            ]);
            const aValid = outcomes[0].ok;
            const other = await devices.refreshDevice(b.tokens.refreshToken, { ...GRACE, now: at(2_000) });
            expect(aValid && other.ok).toBe(false);
        });

        it('keeps strict reuse detection when the window is 0', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE, reuseGraceSec: 0, now: at(0) });
            expect(first.ok).toBe(true);
            expect(await devices.refreshDevice(created.refreshToken, { maxSessionAgeSec: MAX_AGE, reuseGraceSec: 0, now: at(1) }))
                .toEqual({ ok: false, reason: 'reused' });
        });

        it('applies the IdP check and max age within the window', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            expect(await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000), checkIdp: async () => false }))
                .toEqual({ ok: false, reason: 'disabled' });
            expect(await devices.refreshDevice(created.refreshToken, { ...GRACE, maxSessionAgeSec: 1, now: at(2_000) }))
                .toEqual({ ok: false, reason: 'expired' });
        });

        it('still rejects a revoked device within the window', async () => {
            const account = await newAccount();
            const created = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'cli' });
            const first = await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(0) });
            expect(first.ok).toBe(true);
            await devices.revokeDevice(created.deviceId);

            expect(await devices.refreshDevice(created.refreshToken, { ...GRACE, now: at(1_000) }))
                .toEqual({ ok: false, reason: 'revoked' });
        });
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

    describe('isDeviceActive', () => {
        it('accepts an active device of the user', async () => {
            const account = await newAccount();
            const d = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
            expect(await devices.isDeviceActive(d.deviceId, account.id, { maxSessionAgeSec: MAX_AGE })).toBe(true);
        });

        it('rejects a missing device', async () => {
            const account = await newAccount();
            expect(await devices.isDeviceActive('no-such-device', account.id, { maxSessionAgeSec: MAX_AGE })).toBe(false);
        });

        it('rejects a device that belongs to another user', async () => {
            const owner = await newAccount();
            const other = await newAccount();
            const d = await devices.createDevice({ accountId: owner.id, kind: 'cli', name: 'x' });
            expect(await devices.isDeviceActive(d.deviceId, other.id, { maxSessionAgeSec: MAX_AGE })).toBe(false);
        });

        it('rejects a revoked device', async () => {
            const account = await newAccount();
            const d = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
            await devices.revokeDevice(d.deviceId);
            expect(await devices.isDeviceActive(d.deviceId, account.id, { maxSessionAgeSec: MAX_AGE })).toBe(false);
        });

        it('rejects a disabled account', async () => {
            const account = await newAccount({ disabledAt: new Date() });
            const d = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x' });
            expect(await devices.isDeviceActive(d.deviceId, account.id, { maxSessionAgeSec: MAX_AGE })).toBe(false);
        });

        it('rejects a session older than the max age', async () => {
            const account = await newAccount();
            const start = new Date('2026-01-01T00:00:00Z');
            const d = await devices.createDevice({ accountId: account.id, kind: 'cli', name: 'x', now: start });
            const within = new Date(start.getTime() + MAX_AGE * 1000);
            const later = new Date(start.getTime() + (MAX_AGE + 1) * 1000);
            expect(await devices.isDeviceActive(d.deviceId, account.id, { maxSessionAgeSec: MAX_AGE, now: within })).toBe(true);
            expect(await devices.isDeviceActive(d.deviceId, account.id, { maxSessionAgeSec: MAX_AGE, now: later })).toBe(false);
        });
    });
});
