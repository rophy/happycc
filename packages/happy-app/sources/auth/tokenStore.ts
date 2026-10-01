/**
 * Access-token lifecycle: proactive refresh 2 minutes before expiry, single-flight,
 * an optional cross-tab lock, adopt-if-rotated, and invalid_grant → logged out.
 *
 * Pure (no React Native / Expo imports) so it runs under vitest; platform wiring
 * lives in tokenStoreRuntime.ts.
 */
import { decodeJwtExpiry } from './jwt';

export const REFRESH_MARGIN_MS = 2 * 60 * 1000;
export const RETRY_AFTER_ERROR_MS = 30_000;
const MIN_TIMER_MS = 5_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const DEFAULT_LOGOUT_TIMEOUT_MS = 5_000;

export interface StoredCredentials {
    token: string;
    refreshToken: string;
    /** Root secret, base64url (32 bytes). */
    secret: string;
}

/** Stored JSON → credentials. Anything without a token, refresh token and secret is "logged out". */
export function parseStoredCredentials(raw: string | null | undefined): StoredCredentials | null {
    if (!raw) {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (
            typeof value?.token === 'string' && value.token.length > 0 &&
            typeof value.refreshToken === 'string' && value.refreshToken.length > 0 &&
            typeof value.secret === 'string' && value.secret.length > 0
        ) {
            return { token: value.token, refreshToken: value.refreshToken, secret: value.secret };
        }
    } catch {
        // fall through
    }
    return null;
}

export class LoggedOutError extends Error {
    constructor() {
        super('Signed out. Please sign in again.');
        this.name = 'LoggedOutError';
    }
}

export interface AccessTokenProvider {
    serverUrl(): string;
    getAccessToken(): Promise<string>;
    refresh(rejectedToken: string): Promise<string>;
}

export interface TokenStoreDeps {
    serverUrl(): string;
    /** Latest persisted credentials (web: another tab may have rotated them). Omit on native. */
    read?(): Promise<StoredCredentials | null>;
    /** Persist credentials; must throw when they could not be persisted. */
    write(credentials: StoredCredentials): Promise<void>;
    /** Remove persisted credentials only if they still hold `refreshToken`. */
    clearIfRefreshToken(refreshToken: string): Promise<void>;
    /** The server rejected the refresh token: run the app's logout path. */
    onLoggedOut(): void;
    /** Cross-tab mutual exclusion for refresh (web: navigator.locks). */
    withLock?<T>(fn: () => Promise<T>): Promise<T>;
    fetch?: typeof fetch;
    clientId?(): string;
    now?(): number;
    refreshTimeoutMs?: number;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

export class TokenStore implements AccessTokenProvider {
    private credentials: StoredCredentials;
    /** A rotation the server already issued but storage rejected. Never re-send the older refresh token. */
    private pendingRotation: StoredCredentials | null = null;
    private inflight: Promise<string> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    /** Set during an intentional logout so a failing refresh does not trigger a second logout. */
    private silent = false;

    constructor(initial: StoredCredentials, private readonly deps: TokenStoreDeps) {
        this.credentials = initial;
        this.schedule();
    }

    serverUrl(): string {
        return this.deps.serverUrl();
    }

    current(): StoredCredentials {
        return this.credentials;
    }

    hasPendingRotation(): boolean {
        return this.pendingRotation !== null;
    }

    getAccessToken(): Promise<string> {
        if (this.stopped) {
            return Promise.reject(new LoggedOutError());
        }
        if (this.inflight) {
            return this.inflight;
        }
        const token = this.credentials.token;
        return this.isFresh(token) ? Promise.resolve(token) : this.refresh(token);
    }

    refresh(rejectedToken: string): Promise<string> {
        if (this.stopped) {
            return Promise.reject(new LoggedOutError());
        }
        if (!this.inflight) {
            this.inflight = this.runRefresh(rejectedToken)
                .then(
                    (credentials) => {
                        this.credentials = credentials;
                        // A pending rotation still needs to reach storage; retry soon.
                        this.schedule(this.pendingRotation ? RETRY_AFTER_ERROR_MS : undefined);
                        return credentials.token;
                    },
                    (error: unknown) => {
                        if (error instanceof LoggedOutError) {
                            this.signOut();
                        } else {
                            this.schedule(RETRY_AFTER_ERROR_MS);
                        }
                        throw error;
                    },
                )
                .finally(() => {
                    this.inflight = null;
                });
        }
        return this.inflight;
    }

    /** Another tab changed the stored credentials (`storage` event). `raw` is the new value. */
    applyExternalChange(raw: string | null): 'reload' | 'adopted' | 'ignored' {
        if (this.stopped) {
            return 'ignored';
        }
        if (raw === null) {
            this.silent = true;
            this.stop();
            return 'reload';
        }
        const next = parseStoredCredentials(raw);
        if (!next || next.refreshToken === this.credentials.refreshToken) {
            return 'ignored';
        }
        if (next.secret !== this.credentials.secret) {
            // A different account signed in elsewhere; this tab's keys are stale.
            this.silent = true;
            this.stop();
            return 'reload';
        }
        this.credentials = next;
        this.pendingRotation = null;
        this.schedule();
        return 'adopted';
    }

    /** Best-effort `POST /v1/auth/logout`, then stop. Never triggers onLoggedOut. */
    async logoutOnServer(timeoutMs = DEFAULT_LOGOUT_TIMEOUT_MS): Promise<void> {
        this.silent = true;
        try {
            const token = await withTimeout(this.getAccessToken(), timeoutMs);
            await this.fetchWithTimeout(`${this.deps.serverUrl()}/v1/auth/logout`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, ...this.clientHeader() },
            }, timeoutMs);
        } catch {
            // Best effort: the local wipe happens regardless.
        } finally {
            this.stop();
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private signOut(): void {
        const notify = !this.stopped && !this.silent;
        this.stop();
        if (notify) {
            this.deps.onLoggedOut();
        }
    }

    private runRefresh(rejectedToken: string): Promise<StoredCredentials> {
        const work = () => this.adoptOrRefresh(rejectedToken);
        return this.deps.withLock ? this.deps.withLock(work) : work();
    }

    private async adoptOrRefresh(rejectedToken: string): Promise<StoredCredentials> {
        if (this.pendingRotation) {
            const pending = this.pendingRotation;
            try {
                await this.deps.write(pending);
                this.pendingRotation = null;
            } catch {
                // Still pending; keep serving it from memory.
            }
            if (pending.token !== rejectedToken && this.isFresh(pending.token)) {
                return pending;
            }
            return this.redeem(pending);
        }
        const stored = this.deps.read ? await this.deps.read() : this.credentials;
        if (!stored) {
            throw new LoggedOutError();
        }
        if (stored.token !== rejectedToken && this.isFresh(stored.token)) {
            return stored;
        }
        return this.redeem(stored);
    }

    private async redeem(base: StoredCredentials): Promise<StoredCredentials> {
        let response: Response;
        try {
            response = await this.fetchWithTimeout(`${this.deps.serverUrl()}/v1/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.clientHeader() },
                body: JSON.stringify({ refreshToken: base.refreshToken }),
            }, this.deps.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
        } catch (error) {
            throw new Error(`Token refresh failed: ${error instanceof Error ? error.message : 'network error'}`);
        }
        if (response.status === 401) {
            const body = await response.json().catch(() => null) as { error?: string } | null;
            if (body?.error === 'invalid_grant') {
                try {
                    await this.deps.clearIfRefreshToken(base.refreshToken);
                } catch {
                    // The logout path wipes storage anyway.
                }
                throw new LoggedOutError();
            }
        }
        if (!response.ok) {
            throw new Error(`Token refresh failed: HTTP ${response.status}`);
        }
        const data = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
        if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
            throw new Error('Token refresh failed: invalid response');
        }
        const rotated: StoredCredentials = { ...base, token: data.accessToken, refreshToken: data.refreshToken };
        try {
            await this.deps.write(rotated);
            this.pendingRotation = null;
        } catch {
            this.pendingRotation = rotated;
        }
        return rotated;
    }

    private schedule(delayOverrideMs?: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.stopped) {
            return;
        }
        const exp = decodeJwtExpiry(this.credentials.token);
        if (exp === null && delayOverrideMs === undefined) {
            return;
        }
        const delay = delayOverrideMs ?? Math.max(MIN_TIMER_MS, exp! - this.now() - REFRESH_MARGIN_MS);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refresh(this.credentials.token).catch(() => {
                // refresh() already rescheduled or signed out.
            });
        }, delay);
    }

    private isFresh(token: string): boolean {
        const exp = decodeJwtExpiry(token);
        return exp !== null && exp - this.now() > REFRESH_MARGIN_MS;
    }

    private now(): number {
        return this.deps.now ? this.deps.now() : Date.now();
    }

    private clientHeader(): Record<string, string> {
        return this.deps.clientId ? { 'X-Happy-Client': this.deps.clientId() } : {};
    }

    private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const fetchImpl = this.deps.fetch ?? ((input: RequestInfo | URL, options?: RequestInit) => fetch(input, options));
            return await fetchImpl(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }
}
