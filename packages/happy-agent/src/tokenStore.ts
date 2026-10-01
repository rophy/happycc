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

/** A refreshed pair the server already issued but we failed to persist, kept in memory
 *  so the old (about-to-be-revoked) refresh token is never sent to the server again.
 *  `from` is the refresh token that was rotated away from — only safe to persist if the
 *  file still holds it (compare-and-set); otherwise some other process moved on and this
 *  pending write would clobber it. */
type PendingRotation = { from: string; rotated: StoredCredentials };

/**
 * Access token for one happy-agent process. Refreshes on demand (2 minutes before
 * expiry, or after a 401), single-flight within the process and under the credentials
 * file lock across processes; adopts a token another process already rotated.
 */
export class TokenStore implements TokenSource {
    private token: string | null;
    private readonly secret: Uint8Array;
    /** The refresh token actually confirmed on disk — set only from a successful
     *  `readCredentials` or a successful `writeCredentials`, never from an unpersisted
     *  pending rotation. Callers that need "the refresh token the file holds" (e.g. logout,
     *  which clears the file by comparing against it) must use this, not whatever the
     *  server most recently issued us in memory — those can differ for as long as a
     *  rotation is pending. */
    private diskRefreshToken: string | null;
    private inflight: Promise<string> | null = null;
    private pendingRotation: PendingRotation | null = null;

    constructor(private readonly config: Config, credentials: { token: string; secret: Uint8Array; refreshToken?: string }) {
        this.token = credentials.token;
        this.secret = credentials.secret;
        this.diskRefreshToken = credentials.refreshToken ?? null;
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

    /** The refresh token the credentials file actually holds, as last confirmed under the
     *  lock. `null` only before the store has ever read or written credentials (it is given
     *  one at construction). While a rotation is pending (unpersisted), this still returns
     *  the token the file holds, *not* the newer one only held in memory. */
    refreshTokenOnDisk(): string | null {
        return this.diskRefreshToken;
    }

    /** POSTs `/v1/auth/refresh` with `refreshTokenToSend`, retrying once immediately (still
     *  inside the lock) if the first attempt gets no response at all. `refreshTokenOnDisk` is
     *  only used to decide what to clear on an `invalid_grant` — it must be the token the
     *  *file* holds, since that's what `clearCredentialsIfRefreshToken` compares against. */
    private async performRefresh(refreshTokenToSend: string, refreshTokenOnDisk: string): Promise<StoredCredentials> {
        const postRefresh = () => axios.post(
            `${this.config.serverUrl}/v1/auth/refresh`,
            { refreshToken: refreshTokenToSend },
            {
                // `timeout` only bounds inactivity after connect; the abort signal is a hard
                // wall-clock deadline (DNS + connect + response) so the lock is never held long.
                timeout: REFRESH_TIMEOUT_MS,
                signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
                headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
            },
        );

        let data: { accessToken: string; refreshToken: string };
        try {
            let response;
            try {
                response = await postRefresh();
            } catch (firstError) {
                if (firstError instanceof AxiosError && firstError.response) {
                    // A real response (including invalid_grant) — not a lost response, don't retry.
                    throw firstError;
                }
                // No response at all (timeout, abort, connection reset): the server's
                // refresh-reuse grace window covers safely retrying with the same
                // refresh token once, immediately, still inside the lock.
                //
                // This uses up the server's one grace retry for this refresh token. If
                // the server actually processed the first POST and only its response was
                // lost, this retry hits `LOST_RACE` (the token was already rotated) and
                // the device gets revoked. If a *second* process later replays the same
                // on-disk refresh token (e.g. both of this process's attempts also lost
                // their responses), the grace window is already spent and that replay
                // revokes the device too. Rare, and the error path doesn't warn the user
                // about the revoke risk — matches the spec's "one retry per rotation".
                response = await postRefresh();
            }
            data = response.data as { accessToken: string; refreshToken: string };
        } catch (error) {
            if (
                error instanceof AxiosError
                && error.response?.status === 401
                && (error.response.data as { error?: unknown } | undefined)?.error === 'invalid_grant'
            ) {
                clearCredentialsIfRefreshToken(this.config, refreshTokenOnDisk);
                throw new LoggedOutError();
            }
            // Status or error code only: the axios error carries the request body (refresh token).
            const status = error instanceof AxiosError ? error.response?.status : undefined;
            const code = error instanceof AxiosError ? error.code : undefined;
            throw new Error(`Token refresh failed: ${status ?? code ?? 'unknown'}`);
        }

        if (typeof data?.accessToken !== 'string' || typeof data?.refreshToken !== 'string') {
            throw new Error('Token refresh failed: malformed response');
        }

        return { token: data.accessToken, refreshToken: data.refreshToken, secret: this.secret };
    }

    private adoptOrRefresh(rejectedToken: string): Promise<string> {
        return withFileLock(credentialsLockFile(this.config), async () => {
            // Retry a rotation the server already issued but we failed to persist last
            // time, instead of asking the server for another one (that would burn the
            // just-issued refresh token a second time and desync from the server).
            if (this.pendingRotation) {
                const { from, rotated } = this.pendingRotation;
                const current = readCredentials(this.config);
                if (current && sameBytes(current.secret, this.secret) && current.refreshToken === from) {
                    // Confirmed: the file still holds `from` — our pending write is still safe.
                    this.diskRefreshToken = current.refreshToken;

                    if (isFresh(rotated.token) && rotated.token !== rejectedToken) {
                        try {
                            writeCredentials(this.config, rotated);
                            this.pendingRotation = null;
                            this.diskRefreshToken = rotated.refreshToken;
                        } catch {
                            // Still can't persist; keep serving from memory and retry again later.
                        }
                        return rotated.token;
                    }

                    // The pending rotation's token is itself stale or was just rejected.
                    // Refresh again using *its* refresh token — never `from`, which the
                    // server already consumed when it issued `rotated` — and replace the
                    // pending rotation with the new pair, keeping `from` (the file still
                    // hasn't moved) so the next compare-and-set stays correct.
                    const next = await this.performRefresh(rotated.refreshToken, from);
                    this.pendingRotation = { from, rotated: next };
                    try {
                        writeCredentials(this.config, next);
                        this.pendingRotation = null;
                        this.diskRefreshToken = next.refreshToken;
                    } catch {
                        // Still can't persist; keep serving from memory and retry again later.
                    }
                    return next.token;
                }
                // The file moved on from the token we rotated *from* — a concurrent login,
                // or another process's own rotation. Our pending write is no longer safe to
                // apply; drop it and fall through to read-fresh below.
                this.pendingRotation = null;
            }

            const credentials = readCredentials(this.config);
            if (!credentials) {
                throw new LoggedOutError();
            }
            if (!sameBytes(credentials.secret, this.secret)) {
                // Someone signed in as a different account meanwhile; keep their login untouched.
                throw new Error('Stored credentials now belong to a different account. Re-run the command.');
            }
            this.diskRefreshToken = credentials.refreshToken;
            if (credentials.token !== rejectedToken && isFresh(credentials.token)) {
                return credentials.token;
            }

            const rotated = await this.performRefresh(credentials.refreshToken, credentials.refreshToken);
            try {
                writeCredentials(this.config, rotated);
            } catch {
                // The server already rotated; keep serving the new access token from memory
                // and persist it on the next refresh attempt instead of asking the server for
                // another rotation (that would burn the just-issued refresh token a second time).
                this.pendingRotation = { from: credentials.refreshToken, rotated };
                return rotated.token;
            }
            this.diskRefreshToken = rotated.refreshToken;
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
            (token) => {
                try {
                    cb({ ...extra, token });
                } catch {
                    // The consumer's callback is out of our control; never let it become
                    // an unhandled rejection inside this .then handler.
                }
            },
            (error) => {
                if (error instanceof LoggedOutError && onLoggedOut) {
                    try {
                        onLoggedOut(error);
                    } catch {
                        // Same as above: isolate the consumer's handler.
                    }
                    return;
                }
                try {
                    cb({ ...extra, token: '' });
                } catch {
                    // Same as above.
                }
            },
        );
    };
}
