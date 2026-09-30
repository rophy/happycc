import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from './fileLock';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'happy-lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('withFileLock', () => {
    it('runs the callback and releases the lock', async () => {
        const lock = join(dir, 'a.lock');
        const result = await withFileLock(lock, async () => {
            expect(existsSync(lock)).toBe(true);
            return 42;
        });
        expect(result).toBe(42);
        expect(existsSync(lock)).toBe(false);
    });

    it('releases the lock when the callback throws', async () => {
        const lock = join(dir, 'b.lock');
        await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(existsSync(lock)).toBe(false);
    });

    it('serializes concurrent callers', async () => {
        const lock = join(dir, 'c.lock');
        const order: string[] = [];
        const slow = withFileLock(lock, async () => {
            order.push('a:start');
            await new Promise((r) => setTimeout(r, 150));
            order.push('a:end');
        }, { retryIntervalMs: 10 });
        await new Promise((r) => setTimeout(r, 20));
        const fast = withFileLock(lock, async () => { order.push('b'); }, { retryIntervalMs: 10 });
        await Promise.all([slow, fast]);
        expect(order).toEqual(['a:start', 'a:end', 'b']);
    });

    it('breaks a stale lock', async () => {
        const lock = join(dir, 'd.lock');
        writeFileSync(lock, '');
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        await expect(withFileLock(lock, async () => 'ok', { retryIntervalMs: 10 })).resolves.toBe('ok');
    });

    it('gives up after maxAttempts', async () => {
        const lock = join(dir, 'e.lock');
        writeFileSync(lock, '');
        await expect(withFileLock(lock, async () => 'never', { retryIntervalMs: 5, maxAttempts: 3, staleAfterMs: 60_000 }))
            .rejects.toThrow(`Failed to acquire lock ${lock}`);
    });
});
