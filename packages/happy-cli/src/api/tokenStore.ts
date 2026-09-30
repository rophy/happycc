import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { configuration } from '@/configuration';
import { clearCredentialsIfRefreshToken, readCredentials, writeCredentials, type Credentials } from '@/persistence';
import { withFileLock } from '@/utils/fileLock';
import { logger } from '@/ui/logger';
import { decodeJwtExpiry } from './jwt';

const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 30_000;
const MIN_TIMER_MS = 5_000;
const REFRESH_TIMEOUT_MS = 10_000;

/** Lock options for the credentials lock. A stale lock (crashed holder) is reclaimed after 30s;
 *  waiting for a live holder retries every 100ms for up to ~20s. Shared with logout (Task 5). */
export const CREDENTIALS_LOCK_OPTIONS = { staleAfterMs: 30_000, maxAttempts: 200 };

export class LoggedOutError extends Error {
    constructor() {
        super('Logged out: run "happy auth login" to sign in again');
        this.name = 'LoggedOutError';
    }
}

export function credentialsLockFile(): string {
    return configuration.privateKeyFile + '.lock';
}

function isFresh(token: string): boolean {
    const exp = decodeJwtExpiry(token);
    return exp !== null && exp - Date.now() > REFRESH_MARGIN_MS;
}

type RetriableConfig = InternalAxiosRequestConfig & { _happyAuthRetried?: boolean };

/** Same origin as the configured Happy server (a prefix check would match :4000 vs :40001). */
function isHappyServerUrl(url: string): boolean {
    try {
        return new URL(url).origin === new URL(configuration.serverUrl).origin;
    } catch {
        return false;
    }
}

function readAuthorization(config: RetriableConfig): string | undefined {
    const headers: any = config.headers;
    const value = headers?.get?.('Authorization') ?? headers?.Authorization ?? headers?.authorization;
    return typeof value === 'string' ? value : undefined;
}

function writeAuthorization(config: RetriableConfig, value: string): void {
    const headers: any = config.headers;
    if (typeof headers?.set === 'function') {
        headers.set('Authorization', value);
    } else {
        config.headers = { ...(headers ?? {}), Authorization: value } as any;
    }
}

class TokenStore {
    private token: string | null = null;
    private timer: NodeJS.Timeout | null = null;
    private inflight: Promise<string> | null = null;
    private interceptorId: number | null = null;
    private readonly listeners = new Set<(error: LoggedOutError) => void>();
    /** A refreshed pair the server already issued but we failed to persist. Retried before any new POST. */
    private pendingRotation: Credentials | null = null;

    init(credentials: Credentials): void {
        if (this.token !== null) {
            return;
        }
        this.token = credentials.token;
        this.schedule();
        this.installInterceptor();
    }

    current(): string {
        if (this.token === null) {
            throw new Error('Token store is not initialized');
        }
        return this.token;
    }

    async getAccessToken(): Promise<string> {
        if (this.token === null) {
            const credentials = await readCredentials();
            if (!credentials) {
                throw new LoggedOutError();
            }
            this.init(credentials);
        }
        const token = this.token!;
        return isFresh(token) ? token : this.refresh(token);
    }

    refresh(rejectedToken: string): Promise<string> {
        if (!this.inflight) {
            this.inflight = this.adoptOrRefresh(rejectedToken)
                .then((token) => {
                    this.token = token;
                    // A pending rotation still needs to reach disk; don't wait for the next
                    // natural refresh (~13 minutes away) to retry the write.
                    this.schedule(this.pendingRotation ? RETRY_AFTER_ERROR_MS : undefined);
                    return token;
                })
                .catch((error) => {
                    if (error instanceof LoggedOutError) {
                        this.notifyLoggedOut(error);
                    }
                    throw error;
                })
                .finally(() => {
                    this.inflight = null;
                });
        }
        return this.inflight;
    }

    onLoggedOut(listener: (error: LoggedOutError) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    resetForTests(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.interceptorId !== null && axios.interceptors) {
            axios.interceptors.response.eject(this.interceptorId);
        }
        this.token = null;
        this.timer = null;
        this.inflight = null;
        this.interceptorId = null;
        this.pendingRotation = null;
        this.listeners.clear();
    }

    private async adoptOrRefresh(rejectedToken: string): Promise<string> {
        return withFileLock(credentialsLockFile(), async () => {
            // A previous refresh already got a new pair from the server but failed to persist it.
            // Retry the write instead of asking the server for another rotation (that would burn
            // the just-issued refresh token a second time and desync from the server).
            if (this.pendingRotation) {
                const pending = this.pendingRotation;
                await writeCredentials(pending);
                this.pendingRotation = null;
                logger.debug('[AUTH] Persisted a previously pending token rotation');
                return pending.token;
            }

            const credentials = await readCredentials();
            if (!credentials) {
                throw new LoggedOutError();
            }
            if (credentials.token !== rejectedToken && isFresh(credentials.token)) {
                logger.debug('[AUTH] Adopted access token rotated by another process');
                return credentials.token;
            }
            let data: { accessToken: string; refreshToken: string };
            try {
                const response = await axios.post(
                    `${configuration.serverUrl}/v1/auth/refresh`,
                    { refreshToken: credentials.refreshToken },
                    {
                        // `timeout` alone only bounds socket inactivity after connect (axios sets
                        // it via req.setTimeout, which Node applies post-connect). A black-holed
                        // route can hang in DNS/TCP connect for minutes, holding the credentials
                        // lock well past its 30s stale window. AbortSignal.timeout is a hard wall
                        // clock deadline covering DNS + connect + the whole request.
                        timeout: REFRESH_TIMEOUT_MS,
                        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
                        headers: { 'X-Happy-Client': `cli/${configuration.currentCliVersion}` },
                    },
                );
                data = response.data;
            } catch (error) {
                if (axios.isAxiosError(error) && error.response?.status === 401 && (error.response?.data as any)?.error === 'invalid_grant') {
                    await clearCredentialsIfRefreshToken(credentials.refreshToken);
                    throw new LoggedOutError();
                }
                const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                const code = axios.isAxiosError(error) ? error.code : undefined;
                throw new Error(`Token refresh failed: ${status ?? code ?? 'unknown'}`);
            }
            const rotated: Credentials = { ...credentials, token: data.accessToken, refreshToken: data.refreshToken };
            try {
                await writeCredentials(rotated);
            } catch (writeError) {
                // The server already rotated the refresh token; we cannot ask it for another one
                // without burning the one it just issued. Keep serving the new access token from
                // memory and persist it on the next refresh attempt.
                this.pendingRotation = rotated;
                logger.debug('[AUTH] Failed to persist refreshed token; keeping rotation pending', writeError instanceof Error ? writeError.message : writeError);
                return rotated.token;
            }
            logger.debug('[AUTH] Access token refreshed');
            return rotated.token;
        }, CREDENTIALS_LOCK_OPTIONS);
    }

    private schedule(delayOverrideMs?: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const token = this.token;
        const exp = token ? decodeJwtExpiry(token) : null;
        if (!token || exp === null) {
            return;
        }
        const delay = delayOverrideMs ?? Math.max(MIN_TIMER_MS, exp - Date.now() - REFRESH_MARGIN_MS);
        this.timer = setTimeout(() => {
            this.refresh(token).catch((error) => {
                if (!(error instanceof LoggedOutError)) {
                    logger.debug('[AUTH] Background refresh failed; retrying', error instanceof Error ? error.message : error);
                    this.schedule(RETRY_AFTER_ERROR_MS);
                }
            });
        }, delay);
        this.timer.unref?.();
    }

    private installInterceptor(): void {
        if (this.interceptorId !== null || !axios.interceptors) {
            return;
        }
        this.interceptorId = axios.interceptors.response.use(undefined, async (error: AxiosError) => {
            const config = error.config as RetriableConfig | undefined;
            const authorization = config ? readAuthorization(config) : undefined;
            const url = String(config?.url ?? '');
            if (
                !config ||
                config._happyAuthRetried ||
                error.response?.status !== 401 ||
                !authorization?.startsWith('Bearer ') ||
                !isHappyServerUrl(url)
            ) {
                throw error;
            }
            config._happyAuthRetried = true;
            const fresh = await this.refresh(authorization.slice('Bearer '.length));
            writeAuthorization(config, `Bearer ${fresh}`);
            return axios.request(config);
        });
    }

    private notifyLoggedOut(error: LoggedOutError): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.token = null;
        this.pendingRotation = null;
        for (const listener of this.listeners) {
            try {
                listener(error);
            } catch { }
        }
    }
}

export const tokenStore = new TokenStore();
