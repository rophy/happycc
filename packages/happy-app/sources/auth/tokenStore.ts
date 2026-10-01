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
const STOP_AND_SETTLE_TIMEOUT_MS = 6_000;

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

/**
 * Internal: the store was stopped (logout, external-change reload, or
 * `stopAndSettle`) while a refresh was in flight. Never surfaced to deps or
 * scheduled for retry — the caller just sees the operation didn't complete.
 */
class StoppedError extends Error {
    constructor() {
        super('Token store stopped');
        this.name = 'StoppedError';
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
    /**
     * The server rejected a refresh token: run the app's logout path.
     * `failedRefreshToken` is the token the server rejected, so the app can wipe
     * storage only if it still holds that token (not another tab's fresh sign-in).
     * Undefined when the store found storage already empty.
     */
    onLoggedOut(failedRefreshToken?: string): void;
    /**
     * Cross-tab mutual exclusion for refresh (web: navigator.locks). When
     * navigator.locks is unavailable, wire `createLeaseLock(...).withLock`
     * from `./leaseLock` instead (see that module's header comment); it only
     * narrows the window for two tabs refreshing concurrently. The web app
     * must be served over HTTPS (or localhost): sign-in needs crypto.subtle,
     * which only exists in a secure context, where navigator.locks exists too.
     *
     * Also note: if persisting a rotation fails, this store clears the
     * refresh token it just rotated past (see `persist`'s write-failure
     * branch) so other tabs don't redeem a token the server already retired.
     * A tab that was mid-request against that same token will see it gone
     * and log out locally — a deliberate side effect of favoring "log out"
     * over "silently retry a dead token" when persistence itself is failing.
     */
    withLock?<T>(fn: () => Promise<T>): Promise<T>;
    fetch?: typeof fetch;
    clientId?(): string;
    now?(): number;
    refreshTimeoutMs?: number;
}

/** Outcome of `POST /v1/auth/refresh`, decided entirely within its timeout window (body included). */
type RefreshResult =
    | { kind: 'rotated'; accessToken: string; refreshToken: string }
    | { kind: 'invalid_grant' }
    | { kind: 'http_error'; status: number }
    | { kind: 'invalid_response' };

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
    /**
     * A rotation the server already issued but storage rejected. `supersedes`
     * is the refresh token this pair replaced — remembered so a retry can
     * tell "storage still has what we rotated past" (ours, keep retrying;
     * never adopt it back) apart from "storage has something else" (another
     * tab's write, worth adopting or reloading for).
     */
    private pendingRotation: { supersedes: string; rotated: StoredCredentials } | null = null;
    private inflight: Promise<string> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    /** Set during an intentional logout so a failing refresh does not trigger a second logout. */
    private silent = false;
    /** The refresh token the server answered invalid_grant for (kept off the error object so it is never logged). */
    private rejectedRefreshToken: string | undefined;

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
        return this.runSingleFlight(() => this.adoptOrRefresh(rejectedToken));
    }

    /** Retry persisting a pending rotation only — never redeems unless it's actually due. */
    private retryPendingRotationOnly(): Promise<string> {
        return this.runSingleFlight(() => this.persistPendingOnly());
    }

    private runSingleFlight(operation: () => Promise<StoredCredentials>): Promise<string> {
        if (this.stopped) {
            return Promise.reject(new LoggedOutError());
        }
        if (!this.inflight) {
            this.inflight = this.runUnderLock(operation)
                .then(
                    (credentials) => {
                        this.credentials = credentials;
                        // A pending rotation still needs to reach storage; retry soon.
                        this.schedule(this.pendingRotation ? RETRY_AFTER_ERROR_MS : undefined);
                        return credentials.token;
                    },
                    (error: unknown) => {
                        if (error instanceof StoppedError) {
                            // Already stopped (logout / external change); nothing to schedule or notify.
                        } else if (error instanceof LoggedOutError) {
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

    /**
     * Stops the store and waits for any in-flight refresh to settle. Every
     * await inside a refresh re-checks `stopped` before it persists anything,
     * so by the time this resolves nothing further will be written. Callers
     * that are about to wipe credentials locally (e.g. the app's logout path,
     * Task 3) must await this first, so a refresh already in flight can't
     * resurrect the credentials afterwards.
     */
    async stopAndSettle(): Promise<void> {
        this.stop();
        if (this.inflight) {
            // Bounded independently of refreshTimeoutMs: logout must never hang even if
            // the in-flight refresh's own network/body-read timeout is longer than this.
            // `stopped` is already true above, so persist() will refuse to write regardless
            // of whether we actually wait for it here.
            await withTimeout(this.inflight.catch(() => {}), STOP_AND_SETTLE_TIMEOUT_MS).catch(() => {});
        }
    }

    private signOut(): void {
        const notify = !this.stopped && !this.silent;
        this.stop();
        if (notify) {
            this.deps.onLoggedOut(this.rejectedRefreshToken);
        }
    }

    private runUnderLock<T>(fn: () => Promise<T>): Promise<T> {
        return this.deps.withLock ? this.deps.withLock(fn) : fn();
    }

    private async adoptOrRefresh(rejectedToken: string): Promise<StoredCredentials> {
        if (this.stopped) {
            throw new StoppedError();
        }
        if (this.pendingRotation) {
            const { supersedes, rotated } = this.pendingRotation;
            const persisted = await this.persist(supersedes, rotated, { treatMissingAsOurOwnClear: true });
            if (persisted.token !== rejectedToken && this.isFresh(persisted.token)) {
                return persisted;
            }
            return this.redeem(persisted);
        }
        const stored = this.deps.read ? await this.deps.read() : this.credentials;
        if (this.stopped) {
            throw new StoppedError();
        }
        if (!stored) {
            throw new LoggedOutError();
        }
        if (stored.secret !== this.credentials.secret) {
            // Another account signed in elsewhere (its storage event was missed): never
            // adopt or redeem its tokens with this tab's keys. Stop silently, as
            // applyExternalChange and persist() do for a different account.
            this.silent = true;
            this.stop();
            throw new StoppedError();
        }
        if (stored.token !== rejectedToken && this.isFresh(stored.token)) {
            return stored;
        }
        return this.redeem(stored);
    }

    /** Only persists a pending rotation; redeems it only if it's actually due for refresh. */
    private async persistPendingOnly(): Promise<StoredCredentials> {
        if (this.stopped) {
            throw new StoppedError();
        }
        if (!this.pendingRotation) {
            return this.credentials;
        }
        const { supersedes, rotated } = this.pendingRotation;
        const persisted = await this.persist(supersedes, rotated, { treatMissingAsOurOwnClear: true });
        if (this.isFresh(persisted.token)) {
            return persisted;
        }
        return this.redeem(persisted);
    }

    private async redeem(base: StoredCredentials): Promise<StoredCredentials> {
        let result: RefreshResult;
        try {
            result = await this.performRefreshRequest(base);
        } catch (error) {
            throw new Error(`Token refresh failed: ${error instanceof Error ? error.message : 'network error'}`);
        }
        if (this.stopped) {
            throw new StoppedError();
        }
        if (result.kind === 'invalid_grant') {
            this.rejectedRefreshToken = base.refreshToken;
            try {
                await this.deps.clearIfRefreshToken(base.refreshToken);
            } catch {
                // The logout path wipes storage anyway.
            }
            throw new LoggedOutError();
        }
        if (result.kind === 'http_error') {
            throw new Error(`Token refresh failed: HTTP ${result.status}`);
        }
        if (result.kind === 'invalid_response') {
            throw new Error('Token refresh failed: invalid response');
        }
        const rotated: StoredCredentials = { ...base, token: result.accessToken, refreshToken: result.refreshToken };
        // Storage is only expected to be empty on a retry (treatMissingAsOurOwnClear),
        // never on this fresh redemption — a null read here means another tab logged out.
        return this.persist(base.refreshToken, rotated, { treatMissingAsOurOwnClear: false });
    }

    /**
     * Compare-and-set persistence: refuses to overwrite storage unless it
     * still holds `supersedes` (the refresh token this `next` pair replaces)
     * or — only when retrying a pending rotation (`treatMissingAsOurOwnClear`)
     * — is empty (our own earlier best-effort clear). Finding storage still
     * holding exactly `supersedes` is *not* "another tab rotated" — it's our
     * own stale state (e.g. a failed write whose clear also failed) — so
     * that case is never treated as an external change and `next` is never
     * dropped in favor of re-adopting the token we already rotated past.
     * Anything else found in storage is a genuine external change, handled
     * like `applyExternalChange` would (adopt a newer same-account pair, or
     * stop on a null/different-account read for the *initial* redemption).
     *
     * Must run inside the same lock as the read that produced `supersedes`
     * (the caller's `withLock`), and every await here re-checks `stopped`
     * before touching storage.
     */
    private async persist(
        supersedes: string,
        next: StoredCredentials,
        options: { treatMissingAsOurOwnClear: boolean },
    ): Promise<StoredCredentials> {
        if (this.stopped) {
            throw new StoppedError();
        }
        if (this.deps.read) {
            const stored = await this.deps.read();
            if (this.stopped) {
                throw new StoppedError();
            }
            const storedRefreshToken = stored?.refreshToken ?? null;
            const isOurOwnState = storedRefreshToken === supersedes
                || (storedRefreshToken === null && options.treatMissingAsOurOwnClear);
            if (!isOurOwnState) {
                const outcome = this.applyExternalChange(stored ? JSON.stringify(stored) : null);
                if (this.stopped) {
                    throw new StoppedError();
                }
                if (outcome === 'adopted') {
                    return this.credentials;
                }
                // 'ignored' (or storage looked external but applyExternalChange didn't act on
                // it): don't lose `next`; keep it pending and retry later.
                this.pendingRotation = { supersedes, rotated: next };
                return next;
            }
        }
        try {
            await this.deps.write(next);
            this.pendingRotation = null;
            return next;
        } catch {
            // Keep serving `next` from memory and retry persisting it later. Also drop the
            // now-stale `supersedes` token from storage so other tabs don't try to redeem it
            // (the server already rotated past it) — see the side-effect note on
            // `TokenStoreDeps.withLock` above.
            this.pendingRotation = { supersedes, rotated: next };
            try {
                await this.deps.clearIfRefreshToken(supersedes);
            } catch {
                // Best effort.
            }
            return next;
        }
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
            // A pending rotation only needs persisting, not another redemption,
            // unless it has itself gone stale while we were retrying.
            const retry = this.pendingRotation ? this.retryPendingRotationOnly() : this.refresh(this.credentials.token);
            retry.catch(() => {
                // Already rescheduled or signed out.
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

    private fetchImpl(): typeof fetch {
        return this.deps.fetch ?? ((input: RequestInfo | URL, options?: RequestInit) => fetch(input, options));
    }

    /**
     * Runs `run` under both an `AbortController` (so a real `fetch` actually stops
     * the underlying request) and a hard `withTimeout` ceiling (so the operation is
     * bounded even against a `fetch`/`Response` stand-in — real or a test double —
     * that doesn't honor the abort signal, e.g. a `response.json()` that never
     * settles). Used so the *whole* round trip, including reading and parsing the
     * response body, happens within the timeout — not just getting headers back.
     */
    private requestWithTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const guarded = run(controller.signal).finally(() => clearTimeout(timer));
        return withTimeout(guarded, timeoutMs);
    }

    private fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
        return this.requestWithTimeout(timeoutMs, (signal) => this.fetchImpl()(url, { ...init, signal }));
    }

    /** `POST /v1/auth/refresh`, deciding the outcome (status + parsed body) within the timeout window. */
    private performRefreshRequest(base: StoredCredentials): Promise<RefreshResult> {
        const timeoutMs = this.deps.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
        return this.requestWithTimeout(timeoutMs, async (signal) => {
            const response = await this.fetchImpl()(`${this.deps.serverUrl()}/v1/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.clientHeader() },
                body: JSON.stringify({ refreshToken: base.refreshToken }),
                signal,
            });
            if (response.status === 401) {
                const body = await response.json().catch(() => null) as { error?: string } | null;
                return body?.error === 'invalid_grant'
                    ? { kind: 'invalid_grant' as const }
                    : { kind: 'http_error' as const, status: 401 };
            }
            if (!response.ok) {
                return { kind: 'http_error' as const, status: response.status };
            }
            const data = await response.json() as { accessToken?: unknown; refreshToken?: unknown };
            if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
                return { kind: 'invalid_response' as const };
            }
            return { kind: 'rotated' as const, accessToken: data.accessToken, refreshToken: data.refreshToken };
        });
    }
}
