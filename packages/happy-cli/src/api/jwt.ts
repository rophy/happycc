/** Reads `exp` from a JWT without verifying it (the server verifies). Milliseconds, or null. */
export function decodeJwtExpiry(token: string): number | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}
