import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';

export interface AccessTokenClaims {
    userId: string;
    deviceId: string;
}

let signingKey: Buffer | null = null;
let accessTokenTtlSec = 900;

export function initAccessTokens(opts: { masterSecret: string; ttlSec: number }): void {
    signingKey = createHash('sha256').update('happy-access-token:' + opts.masterSecret).digest();
    accessTokenTtlSec = opts.ttlSec;
}

function key(): Buffer {
    if (!signingKey) {
        throw new Error('Access tokens not initialized');
    }
    return signingKey;
}

export function createAccessToken(claims: AccessTokenClaims): string {
    return jwt.sign({ did: claims.deviceId, typ: 'access' }, key(), {
        algorithm: 'HS256',
        subject: claims.userId,
        expiresIn: accessTokenTtlSec,
    });
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
    try {
        const payload = jwt.verify(token, key(), { algorithms: ['HS256'] });
        if (typeof payload !== 'object' || payload.typ !== 'access') {
            return null;
        }
        if (typeof payload.sub !== 'string' || typeof payload.did !== 'string') {
            return null;
        }
        return { userId: payload.sub, deviceId: payload.did };
    } catch {
        return null;
    }
}

export function generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
