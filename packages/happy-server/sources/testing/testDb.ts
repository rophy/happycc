import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';

const migrationsDir = path.join(__dirname, '../../prisma/migrations');

let current: Promise<PrismaClient> | null = null;

/**
 * Creates a PGlite database with all migrations applied and points `@/storage/db`
 * at it. One per test file; call before importing anything that imports `@/storage/db`.
 */
export function createTestDb(): Promise<PrismaClient> {
    current ??= create();
    return current;
}

async function create(): Promise<PrismaClient> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-test-db-'));
    const { runMigrations } = await import('@/standalone');
    await runMigrations({ pgliteDir: dir, migrationsDir });
    process.env.DB_PROVIDER = 'pglite';
    process.env.PGLITE_DIR = dir;
    const { db } = await import('@/storage/db');
    await db.$connect();
    return db;
}
