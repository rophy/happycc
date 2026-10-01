import { constants } from 'node:fs';
import { open, stat, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function withFileLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    opts: { retryIntervalMs?: number; maxAttempts?: number; staleAfterMs?: number } = {},
): Promise<T> {
    const retryIntervalMs = opts.retryIntervalMs ?? 100;
    const maxAttempts = opts.maxAttempts ?? 50;
    const staleAfterMs = opts.staleAfterMs ?? 10_000;

    // Generate unique owner token to detect if lock is stolen by another process
    const ownerToken = `${process.pid}-${randomUUID()}`;

    let handle;
    for (let attempt = 0; attempt < maxAttempts && !handle; attempt++) {
        try {
            handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
            // Write owner token to lock file so we can verify ownership later
            await handle.writeFile(ownerToken);
        } catch (err: any) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            try {
                const stats = await stat(lockPath);
                if (Date.now() - stats.mtimeMs > staleAfterMs) {
                    await unlink(lockPath).catch(() => { });
                    continue;
                }
            } catch { }
            await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
        }
    }
    if (!handle) {
        throw new Error(`Failed to acquire lock ${lockPath}`);
    }
    try {
        return await fn();
    } finally {
        await handle.close();
        // Only unlink if we still own the lock (another process didn't steal it)
        try {
            const currentOwner = await readFile(lockPath, 'utf-8');
            if (currentOwner === ownerToken) {
                await unlink(lockPath);
            }
        } catch {
            // Lock file already gone or unreadable; treat as released
        }
    }
}
