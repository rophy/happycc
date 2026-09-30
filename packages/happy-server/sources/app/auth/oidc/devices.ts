import { db } from '@/storage/db';
import { createAccessToken, generateOpaqueToken, hashToken } from './accessTokens';
import { disconnectDeviceSockets } from './deviceSockets';

export type DeviceKind = 'cli' | 'web' | 'mobile';

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

export type RefreshFailure = 'invalid' | 'reused' | 'revoked' | 'disabled' | 'expired';
export type RefreshResult = { ok: true; tokens: TokenPair } | { ok: false; reason: RefreshFailure };

export async function createDevice(input: {
    accountId: string;
    kind: DeviceKind;
    name: string;
    host?: string | null;
    now?: Date;
}): Promise<TokenPair & { deviceId: string }> {
    const now = input.now ?? new Date();
    const refreshToken = generateOpaqueToken();
    const device = await db.device.create({
        data: {
            accountId: input.accountId,
            kind: input.kind,
            name: input.name,
            host: input.host ?? null,
            refreshTokenHash: hashToken(refreshToken),
            sessionStartedAt: now,
            lastSeenAt: now,
        },
    });
    return {
        deviceId: device.id,
        refreshToken,
        accessToken: createAccessToken({ userId: input.accountId, deviceId: device.id }),
    };
}

export async function refreshDevice(
    refreshToken: string,
    opts: { maxSessionAgeSec: number; now?: Date; checkIdp?: (accountId: string) => Promise<boolean> },
): Promise<RefreshResult> {
    const now = opts.now ?? new Date();
    const hash = hashToken(refreshToken);
    const device = await db.device.findUnique({ where: { refreshTokenHash: hash }, include: { account: true } });
    if (!device) {
        const reused = await db.device.findFirst({ where: { previousRefreshTokenHash: hash } });
        if (reused) {
            await revokeDevice(reused.id);
            return { ok: false, reason: 'reused' };
        }
        return { ok: false, reason: 'invalid' };
    }
    if (device.revokedAt) {
        return { ok: false, reason: 'revoked' };
    }
    if (device.account.disabledAt) {
        return { ok: false, reason: 'disabled' };
    }
    if (now.getTime() - device.sessionStartedAt.getTime() > opts.maxSessionAgeSec * 1000) {
        await revokeDevice(device.id);
        return { ok: false, reason: 'expired' };
    }
    if (opts.checkIdp && !(await opts.checkIdp(device.accountId))) {
        return { ok: false, reason: 'disabled' };
    }

    const next = generateOpaqueToken();
    // Conditional update: a concurrent refresh with the same token loses and gets 'invalid'.
    const updated = await db.device.updateMany({
        where: { id: device.id, refreshTokenHash: hash, revokedAt: null },
        data: { refreshTokenHash: hashToken(next), previousRefreshTokenHash: hash, lastSeenAt: now },
    });
    if (updated.count !== 1) {
        return { ok: false, reason: 'invalid' };
    }
    return {
        ok: true,
        tokens: {
            refreshToken: next,
            accessToken: createAccessToken({ userId: device.accountId, deviceId: device.id }),
        },
    };
}

export async function revokeDevice(deviceId: string): Promise<void> {
    await db.device.updateMany({ where: { id: deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    disconnectDeviceSockets(deviceId);
}

export async function revokeAccountDevices(accountId: string): Promise<void> {
    const active = await db.device.findMany({ where: { accountId, revokedAt: null }, select: { id: true } });
    for (const device of active) {
        await revokeDevice(device.id);
    }
}
