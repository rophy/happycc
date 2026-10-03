import { beforeEach, describe, expect, it, vi } from 'vitest';

const findFirst = vi.fn();
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));

import { sessionBelongsToUser } from './sessionOwnership';

describe('sessionBelongsToUser', () => {
    beforeEach(() => findFirst.mockReset());

    it('is true for the user\'s own session and scopes the query by account', async () => {
        findFirst.mockResolvedValue({ id: 's1' });
        expect(await sessionBelongsToUser('s1', 'u1')).toBe(true);
        expect(findFirst).toHaveBeenCalledWith({ where: { id: 's1', accountId: 'u1' }, select: { id: true } });
    });
    it('is false for another account\'s or a missing session', async () => {
        findFirst.mockResolvedValue(null);
        expect(await sessionBelongsToUser('s2', 'u1')).toBe(false);
    });
});
