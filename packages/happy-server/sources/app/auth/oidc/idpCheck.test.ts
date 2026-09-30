import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';
import type { IdpRefreshResult } from './oidcClient';

let db: PrismaClient;
let idp: typeof import('./idpCheck');
let provisioning: typeof import('./provisioning');
let devices: typeof import('./devices');
let vault: typeof import('./keyVault');

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-that-is-long-enough-000';
    db = await createTestDb();
    await (await import('@/modules/encrypt')).initEncrypt();
    (await import('./accessTokens')).initAccessTokens({ masterSecret: process.env.HANDY_MASTER_SECRET, ttlSec: 900 });
    idp = await import('./idpCheck');
    provisioning = await import('./provisioning');
    devices = await import('./devices');
    vault = await import('./keyVault');
});

function fakeOidc(result: IdpRefreshResult) {
    const calls: string[] = [];
    return { calls, oidc: { refresh: async (token: string) => { calls.push(token); return result; } } };
}

async function accountWithIdpToken(subject: string, checkedAt: Date) {
    const { accountId } = await provisioning.provisionAccount({
        issuer: 'https://idp.test', subject, email: null, name: null, refreshToken: 'idp-rt-1',
    });
    await db.account.update({ where: { id: accountId }, data: { idpCheckedAt: checkedAt } });
    return accountId;
}

const now = new Date('2026-09-30T12:00:00Z');
const stale = new Date(now.getTime() - 15 * 60 * 1000 - 1); // older than IDP_CHECK_INTERVAL_MS

describe('createIdpCheck', () => {
    it('allows accounts without an IdP refresh token without calling the IdP', async () => {
        const { accountId } = await provisioning.provisionAccount({ issuer: 'https://idp.test', subject: 'i-none', email: null, name: null, refreshToken: null });
        const { calls, oidc } = fakeOidc({ status: 'rejected' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
        expect(calls).toEqual([]);
    });

    it('skips the IdP when checked recently', async () => {
        const accountId = await accountWithIdpToken('i-recent', new Date(now.getTime() - 1000));
        const { calls, oidc } = fakeOidc({ status: 'rejected' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
        expect(calls).toEqual([]);
    });

    it('stores a rotated IdP token when the check succeeds', async () => {
        const accountId = await accountWithIdpToken('i-ok', stale);
        const { calls, oidc } = fakeOidc({ status: 'ok', refreshToken: 'idp-rt-2' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
        expect(calls).toEqual(['idp-rt-1']);
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(vault.openIdpRefreshToken(account.idpRefreshToken!)).toBe('idp-rt-2');
        expect(account.idpCheckedAt?.toISOString()).toBe(now.toISOString());
    });

    it('revokes all devices when the IdP rejects the account', async () => {
        const accountId = await accountWithIdpToken('i-rejected', stale);
        const device = await devices.createDevice({ accountId, kind: 'cli', name: 'x' });
        const { oidc } = fakeOidc({ status: 'rejected' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(false);
        const row = await db.device.findUniqueOrThrow({ where: { id: device.deviceId } });
        expect(row.revokedAt).not.toBeNull();
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.idpRefreshToken).toBeNull();
    });

    it('fails open when the IdP is unavailable', async () => {
        const accountId = await accountWithIdpToken('i-down', stale);
        const { oidc } = fakeOidc({ status: 'unavailable' });
        expect(await idp.createIdpCheck({ oidc, now: () => now })(accountId)).toBe(true);
    });

    it('lets only one concurrent caller contact the IdP', async () => {
        const accountId = await accountWithIdpToken('i-race', stale);
        const { calls, oidc } = fakeOidc({ status: 'ok', refreshToken: null });
        const check = idp.createIdpCheck({ oidc, now: () => now });
        const results = await Promise.all([check(accountId), check(accountId), check(accountId)]);
        expect(results).toEqual([true, true, true]);
        expect(calls).toHaveLength(1);
    });
});
