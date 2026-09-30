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

const LOST_RACE = Symbol('lost-race');

type DeviceWithAccount = NonNullable<Awaited<ReturnType<typeof findDeviceWithAccount>>>;

function findDeviceWithAccount(where: { id: string } | { refreshTokenHash: string }) {
    return db.device.findUnique({ where, include: { account: true } });
}

export async function refreshDevice(refreshToken: string, opts: RefreshOptions): Promise<RefreshResult> {
    const now = opts.now ?? new Date();
    const hash = hashToken(refreshToken);
    const device = await findDeviceWithAccount({ refreshTokenHash: hash });
    if (device) {
        const result = await rotate(device, opts, now, null);
        if (result !== LOST_RACE) {
            return result;
        }
        // A concurrent rotation of this same token won (typically a timed-out
        // request the client is retrying while the original still runs). The
        // token is now retired, so handle it like a lost-response retry.
    }
    return redeemRetired(hash, opts, now);
}

async function redeemRetired(hash: string, opts: RefreshOptions, now: Date): Promise<RefreshResult> {
    const retired = await db.retiredRefreshToken.findUnique({ where: { tokenHash: hash } });
    if (!retired) {
        return { ok: false, reason: 'invalid' };
    }
    const graceMs = (opts.reuseGraceSec ?? 0) * 1000;
    if (retired.graceEligible && graceMs > 0 && now.getTime() - retired.retiredAt.getTime() <= graceMs) {
        const current = await findDeviceWithAccount({ id: retired.deviceId });
        if (current) {
            const result = await rotate(current, opts, now, retired.tokenHash);
            if (result !== LOST_RACE) {
                return result;
            }
        }
    }
    await revokeDevice(retired.deviceId);
    return { ok: false, reason: 'reused' };
}

/**
 * Validates the device and replaces its current refresh token with a new one.
 *
 * `graceFrom` is the retired token hash a lost-response retry presented. The
 * rotation then only proceeds if that token is still the device's most
 * recently retired one (checked inside the transaction), and the token it
 * retires is not itself eligible for another grace retry. Returns LOST_RACE
 * when another rotation of the device won; the caller decides what that means.
 */
async function rotate(
    device: DeviceWithAccount,
    opts: RefreshOptions,
    now: Date,
    graceFrom: string | null,
): Promise<RefreshResult | typeof LOST_RACE> {
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
    const rotated = await db.$transaction(async (tx) => {
        if (graceFrom) {
            const latest = await tx.retiredRefreshToken.findFirst({
                where: { deviceId: device.id },
                orderBy: { seq: 'desc' },
                select: { tokenHash: true },
            });
            if (latest?.tokenHash !== graceFrom) {
                return false;
            }
        }
        const updated = await tx.device.updateMany({
            where: { id: device.id, refreshTokenHash: currentHash, revokedAt: null },
            data: { refreshTokenHash: hashToken(next), lastSeenAt: now },
        });
        if (updated.count !== 1) {
            return false;
        }
        await tx.retiredRefreshToken.create({
            data: { tokenHash: currentHash, deviceId: device.id, retiredAt: now, graceEligible: graceFrom === null },
        });
        return true;
    });
    if (!rotated) {
        return LOST_RACE;
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
