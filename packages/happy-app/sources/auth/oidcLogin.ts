/**
 * App side of the server-brokered OIDC login (spec §2 "Web app" / "Mobile"):
 * a PKCE pair binds the exchange code to this app instance, and an ephemeral box
 * keypair receives the root secret sealed by the server.
 */
import sodium from '@/encryption/libsodium.lib';
import { decryptBox } from '@/encryption/libsodium';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { generatePKCE } from '@/utils/oauth';
import type { StoredCredentials } from './tokenStore';

export interface PendingLogin {
    codeVerifier: string;
    codeChallenge: string;
    /** Ephemeral box public key, base64. */
    publicKey: string;
    /** Ephemeral box secret key, base64. Lives only until the exchange. */
    secretKey: string;
}

export class OidcLoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OidcLoginError';
    }
}

export async function createPendingLogin(): Promise<PendingLogin> {
    const { verifier, challenge } = await generatePKCE();
    const keypair = sodium.crypto_box_keypair();
    return {
        codeVerifier: verifier,
        codeChallenge: challenge,
        publicKey: encodeBase64(keypair.publicKey),
        secretKey: encodeBase64(keypair.privateKey),
    };
}

export function buildLoginUrl(
    opts: { serverUrl: string; pending: PendingLogin } & ({ client: 'web' } | { client: 'mobile'; redirectUri: string }),
): string {
    const params = new URLSearchParams({ client: opts.client, code_challenge: opts.pending.codeChallenge });
    if (opts.client === 'mobile') {
        params.set('redirect_uri', opts.redirectUri);
    }
    return `${opts.serverUrl}/v1/auth/oidc/login?${params.toString()}`;
}

/** A pending login older than this is discarded (the user abandoned it; its keys should not linger). */
export const PENDING_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;

export function serializePendingLogin(pending: PendingLogin, now: number = Date.now()): string {
    return JSON.stringify({ ...pending, createdAt: now });
}

/** Null for malformed entries and for entries older than PENDING_LOGIN_MAX_AGE_MS. */
export function deserializePendingLogin(raw: string, now: number = Date.now()): PendingLogin | null {
    try {
        const value = JSON.parse(raw);
        const fields = ['codeVerifier', 'codeChallenge', 'publicKey', 'secretKey'] as const;
        if (
            value && fields.every((field) => typeof value[field] === 'string' && value[field].length > 0) &&
            typeof value.createdAt === 'number' && now - value.createdAt <= PENDING_LOGIN_MAX_AGE_MS
        ) {
            return {
                codeVerifier: value.codeVerifier,
                codeChallenge: value.codeChallenge,
                publicKey: value.publicKey,
                secretKey: value.secretKey,
            };
        }
    } catch {
        // fall through
    }
    return null;
}

export async function exchangeCode(opts: {
    serverUrl: string;
    code: string;
    pending: PendingLogin;
    deviceName: string;
    fetchImpl?: typeof fetch;
}): Promise<StoredCredentials> {
    const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    let response: Response;
    try {
        response = await fetchImpl(`${opts.serverUrl}/v1/auth/oidc/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: opts.code,
                codeVerifier: opts.pending.codeVerifier,
                ephemeralPublicKey: opts.pending.publicKey,
                deviceName: opts.deviceName.slice(0, 100),
            }),
        });
    } catch {
        throw new OidcLoginError('Could not reach the server. Check your connection and try again.');
    }
    if (response.status === 400) {
        throw new OidcLoginError('This sign-in link has expired or was already used. Please sign in again.');
    }
    if (!response.ok) {
        throw new OidcLoginError(`Sign-in failed (HTTP ${response.status}). Please try again.`);
    }
    const data = await response.json() as { accessToken?: unknown; refreshToken?: unknown; keyBundle?: unknown };
    if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string' || typeof data.keyBundle !== 'string') {
        throw new OidcLoginError('The server returned an invalid sign-in response.');
    }
    // 'base64url' decoding also accepts standard base64 (what the server sends).
    const secret = decryptBox(decodeBase64(data.keyBundle, 'base64url'), decodeBase64(opts.pending.secretKey));
    if (!secret || secret.length !== 32) {
        throw new OidcLoginError('The server returned an invalid key bundle.');
    }
    return {
        token: data.accessToken,
        refreshToken: data.refreshToken,
        secret: encodeBase64(secret, 'base64url'),
    };
}
