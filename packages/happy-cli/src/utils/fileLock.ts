import { constants } from 'node:fs';
import { open, stat, unlink } from 'node:fs/promises';

export async function withFileLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    opts: { retryIntervalMs?: number; maxAttempts?: number; staleAfterMs?: number } = {},
): Promise<T> {
    const retryIntervalMs = opts.retryIntervalMs ?? 100;
    const maxAttempts = opts.maxAttempts ?? 50;
    const staleAfterMs = opts.staleAfterMs ?? 10_000;

    let handle;
    for (let attempt = 0; attempt < maxAttempts && !handle; attempt++) {
        try {
            handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
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
        await unlink(lockPath).catch(() => { });
    }
}
