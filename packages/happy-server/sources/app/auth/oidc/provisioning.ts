import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { separateName } from '@/utils/separateName';
import { deriveAccountPublicKeyHex, generateRootSecret } from './accountKeys';
import { keyVault, sealIdpRefreshToken } from './keyVault';
import type { OidcIdentity } from './oidcClient';

export class AccountDisabledError extends Error {
    constructor() {
        super('Account is disabled');
        this.name = 'AccountDisabledError';
    }
}

export async function provisionAccount(identity: OidcIdentity, now: Date = new Date()): Promise<{ accountId: string }> {
    const { accountId } = await upsertAccount(identity, now);
    if (!identity.refreshToken) {
        log(
            { module: 'auth', level: 'warn' },
            `IdP returned no refresh token for account ${accountId}; IdP re-validation is disabled for it (request offline_access)`,
        );
    }
    return { accountId };
}

async function upsertAccount(identity: OidcIdentity, now: Date): Promise<{ accountId: string }> {
    const where = { oidcIssuer_oidcSubject: { oidcIssuer: identity.issuer, oidcSubject: identity.subject } };
    const idpFields = identity.refreshToken
        ? { idpRefreshToken: sealIdpRefreshToken(identity.refreshToken), idpCheckedAt: now }
        : {};

    const existing = await db.account.findUnique({ where });
    if (existing) {
        if (existing.disabledAt) {
            throw new AccountDisabledError();
        }
        await db.account.update({ where: { id: existing.id }, data: { email: identity.email, ...idpFields } });
        return { accountId: existing.id };
    }

    const rootSecret = generateRootSecret();
    const { firstName, lastName } = separateName(identity.name);
    try {
        const created = await db.account.create({
            data: {
                publicKey: deriveAccountPublicKeyHex(rootSecret),
                wrappedRootSecret: keyVault.wrap(rootSecret),
                oidcIssuer: identity.issuer,
                oidcSubject: identity.subject,
                email: identity.email,
                firstName,
                lastName,
                ...idpFields,
            },
        });
        return { accountId: created.id };
    } catch (error) {
        // Concurrent first login for the same identity: the other request won.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const winner = await db.account.findUniqueOrThrow({ where });
            return { accountId: winner.id };
        }
        throw error;
    }
}
