import axios, { AxiosError } from 'axios';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    clearCredentialsIfRefreshToken,
    credentialsLockFile,
    readCredentials,
    writeCredentials,
    type StoredCredentials,
} from './credentials';
import { withFileLock } from './fileLock';
import { decodeJwtExpiry } from './jwt';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

export class LoggedOutError extends Error {
    constructor() {
        super('Logged out. Run `happy-agent auth login` to sign in again.');
        this.name = 'LoggedOutError';
    }
}

export interface TokenSource {
    getAccessToken(): Promise<string>;
    refresh(rejectedToken: string): Promise<string>;
}

function isFresh(token: string): boolean {
    const exp = decodeJwtExpiry(token);
    return exp !== null && exp - Date.now() > REFRESH_MARGIN_MS;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return Buffer.from(a).equals(Buffer.from(b));
}

/**
 * Access token for one happy-agent process. Refreshes on demand (2 minutes before
 * expiry, or after a 401), single-flight within the process and under the credentials
 * file lock across processes; adopts a token another process already rotated.
 */
export class TokenStore implements TokenSource {
    private token: string | null;
    private readonly secret: Uint8Array;
    private inflight: Promise<string> | null = null;

    constructor(private readonly config: Config, credentials: { token: string; secret: Uint8Array }) {
        this.token = credentials.token;
        this.secret = credentials.secret;
    }

    async getAccessToken(): Promise<string> {
        if (this.token === null) {
            throw new LoggedOutError();
        }
        const token = this.token;
        return isFresh(token) ? token : this.refresh(token);
    }

    refresh(rejectedToken: string): Promise<string> {
        if (!this.inflight) {
            this.inflight = this.adoptOrRefresh(rejectedToken)
                .then((token) => {
                    this.token = token;
                    return token;
                })
                .catch((error) => {
                    if (error instanceof LoggedOutError) {
                        this.token = null;
                    }
                    throw error;
                })
                .finally(() => {
                    this.inflight = null;
                });
        }
        return this.inflight;
    }

    private adoptOrRefresh(rejectedToken: string): Promise<string> {
        return withFileLock(credentialsLockFile(this.config), async () => {
            const credentials = readCredentials(this.config);
            if (!credentials) {
                throw new LoggedOutError();
            }
            if (!sameBytes(credentials.secret, this.secret)) {
                // Someone signed in as a different account meanwhile; keep their login untouched.
                throw new Error('Stored credentials now belong to a different account. Re-run the command.');
            }
            if (credentials.token !== rejectedToken && isFresh(credentials.token)) {
                return credentials.token;
            }
            let data: { accessToken: string; refreshToken: string };
            try {
                const response = await axios.post(
                    `${this.config.serverUrl}/v1/auth/refresh`,
                    { refreshToken: credentials.refreshToken },
                    {
                        // `timeout` only bounds inactivity after connect; the abort signal is a hard
                        // wall-clock deadline (DNS + connect + response) so the lock is never held long.
                        timeout: REFRESH_TIMEOUT_MS,
                        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
                        headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
                    },
                );
                data = response.data as { accessToken: string; refreshToken: string };
            } catch (error) {
                if (
                    error instanceof AxiosError
                    && error.response?.status === 401
                    && (error.response.data as { error?: unknown } | undefined)?.error === 'invalid_grant'
                ) {
                    clearCredentialsIfRefreshToken(this.config, credentials.refreshToken);
                    throw new LoggedOutError();
                }
                // Status or error code only: the axios error carries the request body (refresh token).
                const status = error instanceof AxiosError ? error.response?.status : undefined;
                const code = error instanceof AxiosError ? error.code : undefined;
                throw new Error(`Token refresh failed: ${status ?? code ?? 'unknown'}`);
            }
            const rotated: StoredCredentials = { token: data.accessToken, refreshToken: data.refreshToken, secret: credentials.secret };
            writeCredentials(this.config, rotated);
            return rotated.token;
        }, CREDENTIALS_LOCK_OPTIONS);
    }
}

function sameOrigin(url: string, serverUrl: string): boolean {
    try {
        return new URL(url).origin === new URL(serverUrl).origin;
    } catch {
        return false;
    }
}

/** Sends with the current token; on a 401 from the configured server, refreshes and retries once. */
export async function withAuthRetry<T>(
    tokens: TokenSource,
    serverUrl: string,
    url: string,
    send: (token: string) => Promise<T>,
): Promise<T> {
    const token = await tokens.getAccessToken();
    try {
        return await send(token);
    } catch (error) {
        if (!(error instanceof AxiosError) || error.response?.status !== 401 || !sameOrigin(url, serverUrl)) {
            throw error;
        }
        const fresh = await tokens.refresh(token);
        return send(fresh);
    }
}

export type SocketAuthCallback = (cb: (data: object) => void) => void;

/**
 * socket.io `auth` callback: awaits a fresh token at every (re)connect. A logged-out
 * store goes to `onLoggedOut` (nothing will fix it, so the caller stops reconnecting);
 * other failures send an empty token so the server refuses the handshake.
 */
export function socketAuth(
    tokens: Pick<TokenSource, 'getAccessToken'>,
    extra: Record<string, unknown>,
    onLoggedOut?: (error: LoggedOutError) => void,
): SocketAuthCallback {
    return (cb) => {
        tokens.getAccessToken().then(
            (token) => cb({ ...extra, token }),
            (error) => {
                if (error instanceof LoggedOutError && onLoggedOut) {
                    onLoggedOut(error);
                    return;
                }
                cb({ ...extra, token: '' });
            },
        );
    };
}
