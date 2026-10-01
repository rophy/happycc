/**
 * localStorage lease-lock fallback for cross-tab refresh exclusion when
 * `navigator.locks` is unavailable. Pure (no DOM/RN imports) so it runs under
 * vitest; storage and clock are injected.
 *
 * Not a true mutex — localStorage writes aren't atomic across tabs — but the
 * write-wait-reread dance makes a collision between two tabs racing to
 * acquire at the same instant unlikely, and a lease that outlives its holder
 * (e.g. a crashed tab) self-heals via `expires`.
 *
 * Wiring (Task 3 / tokenStoreRuntime.ts, on web only):
 *   const withLock = typeof navigator !== 'undefined' && navigator.locks
 *       ? (fn) => navigator.locks.request('happy-auth-refresh', fn)
 *       : createLeaseLock(window.localStorage).withLock;
 */

export const LEASE_LOCK_KEY = 'happy-auth-refresh-lease';
const LEASE_DURATION_MS = 15_000;
const ACQUIRE_CONFIRM_DELAY_MS = 50;
const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 200;
const ACQUIRE_TIMEOUT_MS = 20_000;

export interface LeaseStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface LeaseClock {
    now(): number;
    sleep(ms: number): Promise<void>;
    randomOwnerId(): string;
}

export const defaultLeaseClock: LeaseClock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomOwnerId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
};

interface Lease {
    owner: string;
    expires: number;
}

function readLease(storage: LeaseStorage): Lease | null {
    const raw = storage.getItem(LEASE_LOCK_KEY);
    if (!raw) {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (typeof value?.owner === 'string' && typeof value?.expires === 'number') {
            return value;
        }
    } catch {
        // fall through
    }
    return null;
}

function jitter(): number {
    return RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
}

/** A small, separately unit-testable lease lock with an injected storage and clock. */
export function createLeaseLock(storage: LeaseStorage, clock: LeaseClock = defaultLeaseClock) {
    async function acquire(): Promise<string> {
        const deadline = clock.now() + ACQUIRE_TIMEOUT_MS;
        while (true) {
            const existing = readLease(storage);
            const isLive = existing !== null && existing.expires > clock.now();
            if (!isLive) {
                const owner = clock.randomOwnerId();
                storage.setItem(LEASE_LOCK_KEY, JSON.stringify({ owner, expires: clock.now() + LEASE_DURATION_MS }));
                await clock.sleep(ACQUIRE_CONFIRM_DELAY_MS);
                const confirmed = readLease(storage);
                if (confirmed?.owner === owner) {
                    return owner;
                }
                // Someone else won the race in the confirmation window; fall through to retry.
            }
            if (clock.now() >= deadline) {
                throw new Error('Timed out waiting for the auth refresh lock');
            }
            await clock.sleep(jitter());
        }
    }

    function release(owner: string): void {
        const current = readLease(storage);
        if (current?.owner === owner) {
            storage.removeItem(LEASE_LOCK_KEY);
        }
    }

    async function withLock<T>(fn: () => Promise<T>): Promise<T> {
        const owner = await acquire();
        try {
            return await fn();
        } finally {
            release(owner);
        }
    }

    return { withLock, acquire, release };
}
