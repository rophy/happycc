import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createTestDb } from '@/testing/testDb';

let db: PrismaClient;
let provisioning: typeof import('./provisioning');
let keys: typeof import('./accountKeys');
let vault: typeof import('./keyVault');

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-that-is-long-enough-000';
    db = await createTestDb();
    await (await import('@/modules/encrypt')).initEncrypt();
    provisioning = await import('./provisioning');
    keys = await import('./accountKeys');
    vault = await import('./keyVault');
});

const identity = (subject: string, extra: Partial<import('./oidcClient').OidcIdentity> = {}) => ({
    issuer: 'https://idp.test', subject, email: `${subject}@example.com`, name: 'Alice Example', refreshToken: null, ...extra,
});

describe('provisionAccount', () => {
    it('creates an account with a wrapped root secret on first login', async () => {
        const { accountId } = await provisioning.provisionAccount(identity('p-alice'));
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        const root = vault.keyVault.unwrap(account.wrappedRootSecret!);
        expect(root).toHaveLength(32);
        expect(account.publicKey).toBe(keys.deriveAccountPublicKeyHex(root));
        expect(account).toMatchObject({ email: 'p-alice@example.com', firstName: 'Alice', lastName: 'Example' });
    });

    it('returns the same account on later logins and keeps the secret', async () => {
        const first = await provisioning.provisionAccount(identity('p-bob'));
        const before = await db.account.findUniqueOrThrow({ where: { id: first.accountId } });
        const second = await provisioning.provisionAccount(identity('p-bob', { email: 'bob.new@example.com' }));
        const after = await db.account.findUniqueOrThrow({ where: { id: second.accountId } });
        expect(second.accountId).toBe(first.accountId);
        expect(after.wrappedRootSecret).toBe(before.wrappedRootSecret);
        expect(after.email).toBe('bob.new@example.com');
    });

    it('stores the IdP refresh token sealed', async () => {
        const { accountId } = await provisioning.provisionAccount(identity('p-carol', { refreshToken: 'idp-rt' }));
        const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
        expect(account.idpRefreshToken).not.toBe('idp-rt');
        expect(vault.openIdpRefreshToken(account.idpRefreshToken!)).toBe('idp-rt');
        expect(account.idpCheckedAt).not.toBeNull();
    });

    it('refuses disabled accounts', async () => {
        const { accountId } = await provisioning.provisionAccount(identity('p-dave'));
        await db.account.update({ where: { id: accountId }, data: { disabledAt: new Date() } });
        await expect(provisioning.provisionAccount(identity('p-dave'))).rejects.toBeInstanceOf(provisioning.AccountDisabledError);
    });

    it('keeps issuers separate', async () => {
        const a = await provisioning.provisionAccount(identity('p-same'));
        const b = await provisioning.provisionAccount({ ...identity('p-same'), issuer: 'https://other-idp.test' });
        expect(a.accountId).not.toBe(b.accountId);
    });
});
