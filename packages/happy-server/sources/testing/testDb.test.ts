import { describe, expect, it } from 'vitest';
import { createTestDb } from './testDb';

describe('createTestDb', () => {
    it('creates a migrated database that Prisma can use', async () => {
        const db = await createTestDb();
        const account = await db.account.create({ data: { publicKey: 'test-public-key' } });
        const found = await db.account.findUnique({ where: { id: account.id } });
        expect(found?.publicKey).toBe('test-public-key');
    });

    it('has the OIDC auth tables', async () => {
        const db = await createTestDb();
        const account = await db.account.create({
            data: { publicKey: 'pk-oidc', oidcIssuer: 'https://idp.test', oidcSubject: 'alice', wrappedRootSecret: 'wrapped' },
        });
        const device = await db.device.create({
            data: {
                accountId: account.id, kind: 'cli', name: 'dev-42', host: 'dev-42',
                refreshTokenHash: 'h1', sessionStartedAt: new Date(), lastSeenAt: new Date(),
            },
        });
        const request = await db.deviceAuthRequest.create({
            data: {
                deviceCodeHash: 'dc', userCode: 'BCDF-GHJK', ephemeralPublicKey: 'eph',
                clientInfo: { host: 'dev-42', os: 'linux', cliVersion: '1.2.5' },
                expiresAt: new Date(Date.now() + 600_000),
            },
        });
        const code = await db.oidcExchangeCode.create({
            data: { codeHash: 'ch', accountId: account.id, clientKind: 'web', pkceChallenge: 'c', expiresAt: new Date() },
        });
        expect(device.revokedAt).toBeNull();
        expect(request.status).toBe('pending');
        expect(code.usedAt).toBeNull();
        const byIdentity = await db.account.findUnique({
            where: { oidcIssuer_oidcSubject: { oidcIssuer: 'https://idp.test', oidcSubject: 'alice' } },
        });
        expect(byIdentity?.id).toBe(account.id);
    });
});
