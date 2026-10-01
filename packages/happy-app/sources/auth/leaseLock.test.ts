import { describe, expect, it } from 'vitest';
import { createLeaseLock, LEASE_LOCK_KEY, type LeaseClock, type LeaseStorage } from './leaseLock';

function fakeStorage(): LeaseStorage {
    const map = new Map<string, string>();
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => { map.set(key, value); },
        removeItem: (key) => { map.delete(key); },
    };
}

/** A clock whose sleep() advances a virtual clock instantly, for deterministic tests. */
function fakeClock(startAt = 0): LeaseClock {
    let now = startAt;
    let ownerSeq = 0;
    return {
        now: () => now,
        sleep: async (ms) => { now += ms; },
        randomOwnerId: () => `owner-${ownerSeq++}`,
    };
}

describe('createLeaseLock', () => {
    it('serializes two concurrent withLock calls, one tab at a time', async () => {
        const storage = fakeStorage();
        const clock = fakeClock();
        const lock = createLeaseLock(storage, clock);
        const order: string[] = [];

        const run = (name: string) => lock.withLock(async () => {
            order.push(`${name}-start`);
            order.push(`${name}-end`);
        });

        await Promise.all([run('a'), run('b')]);

        expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
        // The lease is released after the second holder finishes.
        expect(storage.getItem(LEASE_LOCK_KEY)).toBeNull();
    });

    it('does not release a lease that expired and was taken over by someone else', async () => {
        const storage = fakeStorage();
        const clock = fakeClock();
        const lock = createLeaseLock(storage, clock);
        const owner = await lock.acquire();
        // Simulate another tab taking over after our lease expired.
        storage.setItem(LEASE_LOCK_KEY, JSON.stringify({ owner: 'someone-else', expires: clock.now() + 15_000 }));
        lock.release(owner);
        expect(storage.getItem(LEASE_LOCK_KEY)).not.toBeNull();
        expect(JSON.parse(storage.getItem(LEASE_LOCK_KEY)!).owner).toBe('someone-else');
    });

    it('gives up with a non-auth error after ~20s when the lease never frees up', async () => {
        const storage = fakeStorage();
        const clock = fakeClock();
        // Someone else holds a lease that keeps renewing itself for longer than our timeout.
        storage.setItem(LEASE_LOCK_KEY, JSON.stringify({ owner: 'someone-else', expires: 1_000_000 }));
        const lock = createLeaseLock(storage, clock);
        await expect(lock.acquire()).rejects.toThrow(/Timed out/);
    });

    it('acquires once an expired lease is found', async () => {
        const storage = fakeStorage();
        const clock = fakeClock();
        storage.setItem(LEASE_LOCK_KEY, JSON.stringify({ owner: 'stale-owner', expires: -1 }));
        const lock = createLeaseLock(storage, clock);
        const owner = await lock.acquire();
        expect(owner).toBeTruthy();
        expect(JSON.parse(storage.getItem(LEASE_LOCK_KEY)!).owner).toBe(owner);
    });
});
