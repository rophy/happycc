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

type RefreshOptions = {
    maxSessionAgeSec: number;
    /**
     * How long the immediately previous refresh token stays redeemable after a
     * rotation. Covers a lost response: the client never saw the new pair and
     * retries with the old token. 0 disables the window.
     */
    reuseGraceSec?: number;
    now?: Date;
    checkIdp?: (accountId: string) => Promise<boolean>;
};

type DeviceWithAccount = NonNullable<Awaited<ReturnType<typeof findDeviceWithAccount>>>;

function findDeviceWithAccount(where: { id: string } | { refreshTokenHash: string }) {
    return db.device.findUnique({ where, include: { account: true } });
}

export async function refreshDevice(refreshToken: string, opts: RefreshOptions): Promise<RefreshResult> {
    const now = opts.now ?? new Date();
    const hash = hashToken(refreshToken);
    const device = await findDeviceWithAccount({ refreshTokenHash: hash });
    if (device) {
        return rotate(device, opts, now);
    }

    const retired = await db.retiredRefreshToken.findUnique({ where: { tokenHash: hash } });
    if (!retired) {
        return { ok: false, reason: 'invalid' };
    }
    if (await isWithinReuseGrace(retired, opts.reuseGraceSec ?? 0, now)) {
        const current = await findDeviceWithAccount({ id: retired.deviceId });
        if (current) {
            return rotate(current, opts, now);
        }
    }
    await revokeDevice(retired.deviceId);
    return { ok: false, reason: 'reused' };
}

/** Only the device's most recently retired token, and only within the window. */
async function isWithinReuseGrace(
    retired: { tokenHash: string; deviceId: string; retiredAt: Date },
    graceSec: number,
    now: Date,
): Promise<boolean> {
    if (graceSec <= 0 || now.getTime() - retired.retiredAt.getTime() > graceSec * 1000) {
        return false;
    }
    const latest = await db.retiredRefreshToken.findFirst({
        where: { deviceId: retired.deviceId },
        orderBy: { retiredAt: 'desc' },
        select: { tokenHash: true },
    });
    return latest?.tokenHash === retired.tokenHash;
}

/** Validates the device and replaces its current refresh token with a new one. */
async function rotate(device: DeviceWithAccount, opts: RefreshOptions, now: Date): Promise<RefreshResult> {
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

    const currentHash = device.refreshTokenHash;
    const next = generateOpaqueToken();
    // Conditional update: a concurrent refresh of the same token loses and gets 'invalid'.
    const rotated = await db.$transaction(async (tx) => {
        const updated = await tx.device.updateMany({
            where: { id: device.id, refreshTokenHash: currentHash, revokedAt: null },
            data: { refreshTokenHash: hashToken(next), lastSeenAt: now },
        });
        if (updated.count !== 1) {
            return false;
        }
        await tx.retiredRefreshToken.create({ data: { tokenHash: currentHash, deviceId: device.id, retiredAt: now } });
        return true;
    });
    if (!rotated) {
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

/**
 * Whether a device may keep using its access token (socket handshake): the device
 * exists, belongs to the user, is not revoked, its account is not disabled and its
 * session is within the max session age.
 */
export async function isDeviceActive(
    deviceId: string,
    userId: string,
    opts: { maxSessionAgeSec: number; now?: Date },
): Promise<boolean> {
    const now = opts.now ?? new Date();
    const device = await db.device.findUnique({ where: { id: deviceId }, include: { account: true } });
    if (!device || device.accountId !== userId) {
        return false;
    }
    if (device.revokedAt || device.account.disabledAt) {
        return false;
    }
    return now.getTime() - device.sessionStartedAt.getTime() <= opts.maxSessionAgeSec * 1000;
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
