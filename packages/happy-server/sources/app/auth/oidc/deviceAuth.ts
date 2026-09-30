import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { generateOpaqueToken, hashToken } from './accessTokens';

export const DEVICE_CODE_TTL_SEC = 600;
export const POLL_INTERVAL_SEC = 5;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export interface ClientInfo {
    host: string;
    os: string;
    cliVersion: string;
}

export type PollResult =
    | { status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'invalid' }
    | { status: 'approved'; accountId: string; ephemeralPublicKey: string; clientInfo: ClientInfo };

export function generateUserCode(): string {
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeUserCode(input: string): string | null {
    const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
    return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
}

export async function startDeviceAuth(input: {
    ephemeralPublicKey: string;
    clientInfo: ClientInfo;
}): Promise<{ deviceCode: string; userCode: string }> {
    // Keep the unique userCode space small by removing long-expired requests.
    await db.deviceAuthRequest.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } });
    const deviceCode = generateOpaqueToken();
    for (let attempt = 0; attempt < 5; attempt++) {
        const userCode = generateUserCode();
        try {
            await db.deviceAuthRequest.create({
                data: {
                    deviceCodeHash: hashToken(deviceCode),
                    userCode,
                    ephemeralPublicKey: input.ephemeralPublicKey,
                    clientInfo: { ...input.clientInfo },
                    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SEC * 1000),
                },
            });
            return { deviceCode, userCode };
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
                throw error;
            }
        }
    }
    throw new Error('Could not allocate a unique user code');
}

export async function findPendingRequest(userCode: string): Promise<{ userCode: string; clientInfo: ClientInfo } | null> {
    const row = await db.deviceAuthRequest.findUnique({ where: { userCode } });
    if (!row || row.status !== 'pending' || row.expiresAt.getTime() < Date.now()) {
        return null;
    }
    return { userCode: row.userCode, clientInfo: row.clientInfo as unknown as ClientInfo };
}

export async function decideDeviceAuth(userCode: string, accountId: string, decision: 'approve' | 'deny'): Promise<boolean> {
    const updated = await db.deviceAuthRequest.updateMany({
        where: { userCode, status: 'pending', expiresAt: { gt: new Date() } },
        data: decision === 'approve'
            ? { status: 'approved', approvedAccountId: accountId }
            : { status: 'denied' },
    });
    return updated.count === 1;
}

export async function pollDeviceAuth(deviceCode: string, now: Date = new Date()): Promise<PollResult> {
    const row = await db.deviceAuthRequest.findUnique({ where: { deviceCodeHash: hashToken(deviceCode) } });
    if (!row || row.status === 'consumed') {
        return { status: 'invalid' };
    }
    if (row.expiresAt.getTime() < now.getTime()) {
        return { status: 'expired' };
    }
    if (row.status === 'denied') {
        return { status: 'denied' };
    }
    const tooFast = row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < POLL_INTERVAL_SEC * 1000;
    await db.deviceAuthRequest.update({ where: { id: row.id }, data: { lastPolledAt: now } });
    if (tooFast) {
        return { status: 'slow_down' };
    }
    if (row.status === 'pending') {
        return { status: 'pending' };
    }
    const claimed = await db.deviceAuthRequest.updateMany({
        where: { id: row.id, status: 'approved' },
        data: { status: 'consumed' },
    });
    if (claimed.count !== 1 || !row.approvedAccountId) {
        return { status: 'invalid' };
    }
    return {
        status: 'approved',
        accountId: row.approvedAccountId,
        ephemeralPublicKey: row.ephemeralPublicKey,
        clientInfo: row.clientInfo as unknown as ClientInfo,
    };
}
