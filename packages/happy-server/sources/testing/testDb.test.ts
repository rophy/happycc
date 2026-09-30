import { describe, expect, it } from 'vitest';
import { createTestDb } from './testDb';

describe('createTestDb', () => {
    it('creates a migrated database that Prisma can use', async () => {
        const db = await createTestDb();
        const account = await db.account.create({ data: { publicKey: 'test-public-key' } });
        const found = await db.account.findUnique({ where: { id: account.id } });
        expect(found?.publicKey).toBe('test-public-key');
    });
});
