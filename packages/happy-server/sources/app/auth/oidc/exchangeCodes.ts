import { createHash } from 'crypto';
import { db } from '@/storage/db';
import { generateOpaqueToken, hashToken } from './accessTokens';

const EXCHANGE_CODE_TTL_MS = 60_000;

export async function createExchangeCode(input: {
    accountId: string;
    clientKind: 'web' | 'mobile';
    pkceChallenge: string;
}): Promise<string> {
    const code = generateOpaqueToken();
    await db.oidcExchangeCode.create({
        data: {
            codeHash: hashToken(code),
            accountId: input.accountId,
            clientKind: input.clientKind,
            pkceChallenge: input.pkceChallenge,
            expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS),
        },
    });
    return code;
}

export async function redeemExchangeCode(
    code: string,
    codeVerifier: string,
): Promise<{ accountId: string; clientKind: 'web' | 'mobile' } | null> {
    const row = await db.oidcExchangeCode.findUnique({ where: { codeHash: hashToken(code) } });
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
        return null;
    }
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    if (challenge !== row.pkceChallenge) {
        return null;
    }
    const claimed = await db.oidcExchangeCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
        return null;
    }
    return { accountId: row.accountId, clientKind: row.clientKind as 'web' | 'mobile' };
}
