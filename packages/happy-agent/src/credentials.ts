import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveContentKeyPair, decodeBase64, encodeBase64 } from './encryption';
import type { Config } from './config';

/** What agent.key holds. `secret` is the account root secret delivered at login. */
export type StoredCredentials = {
    token: string;
    refreshToken: string;
    secret: Uint8Array;
};

export type Credentials = StoredCredentials & {
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
};

/** A stale lock (crashed holder) is reclaimed after 30 s; a live holder is awaited for up to ~20 s. */
export const CREDENTIALS_LOCK_OPTIONS = { staleAfterMs: 30_000, maxAttempts: 200 };

export function credentialsLockFile(config: Config): string {
    return `${config.credentialPath}.lock`;
}

export function ensureCredentialsDir(config: Config): void {
    mkdirSync(dirname(config.credentialPath), { recursive: true, mode: 0o700 });
}

/** Null when the file is missing, unreadable, or lacks a refresh token (pre-OIDC credentials count as logged out). */
export function readCredentials(config: Config): Credentials | null {
    try {
        const parsed = JSON.parse(readFileSync(config.credentialPath, 'utf-8')) as {
            token?: unknown;
            refreshToken?: unknown;
            secret?: unknown;
        };
        if (
            typeof parsed.token !== 'string' || parsed.token.length === 0
            || typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0
            || typeof parsed.secret !== 'string' || parsed.secret.length === 0
        ) {
            return null;
        }
        const secret = decodeBase64(parsed.secret);
        if (secret.length !== 32) {
            return null;
        }
        return {
            token: parsed.token,
            refreshToken: parsed.refreshToken,
            secret,
            contentKeyPair: deriveContentKeyPair(secret),
        };
    } catch {
        return null;
    }
}

/** Atomic write (temp file + rename, mode 0600). Callers hold credentialsLockFile(config). */
export function writeCredentials(config: Config, credentials: StoredCredentials): void {
    ensureCredentialsDir(config);
    const tmp = `${config.credentialPath}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify({
        token: credentials.token,
        refreshToken: credentials.refreshToken,
        secret: encodeBase64(credentials.secret),
    }), { mode: 0o600 });
    renameSync(tmp, config.credentialPath);
}

export function clearCredentials(config: Config): void {
    rmSync(config.credentialPath, { force: true });
}

/** Clears the credentials only if they still carry `refreshToken`, so a newer login is kept. */
export function clearCredentialsIfRefreshToken(config: Config, refreshToken: string): boolean {
    const current = readCredentials(config);
    if (!current || current.refreshToken !== refreshToken) {
        return false;
    }
    clearCredentials(config);
    return true;
}

export function requireCredentials(config: Config): Credentials {
    const creds = readCredentials(config);
    if (!creds) {
        throw new Error('Not authenticated. Run `happy-agent auth login` first.');
    }
    return creds;
}
