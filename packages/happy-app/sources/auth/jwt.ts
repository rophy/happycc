import { decodeBase64 } from '@/encryption/base64';
import { decodeUTF8 } from '@/encryption/text';

/** Reads a JWT payload without verifying it (the server verifies). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
        return null;
    }
    try {
        const payload = JSON.parse(decodeUTF8(decodeBase64(parts[1], 'base64url')));
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    } catch {
        return null;
    }
}

/** `exp` in milliseconds, or null when the token is not a JWT with a numeric exp. */
export function decodeJwtExpiry(token: string): number | null {
    const payload = decodeJwtPayload(token);
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}
