import { describe, expect, it, vi } from 'vitest';
import { getSideChatForkSource, spawnSideChatFrom } from './sideChat';
import type { Session } from '@/sync/storageTypes';

const session = {
    id: 's1',
    metadata: { flavor: 'claude', machineId: 'm1', path: '/w', claudeSessionId: 'c1' },
} as unknown as Session;

describe('side chats', () => {
    it('has a fork source when the build can start sessions', () => {
        expect(getSideChatForkSource(session, false)).toMatchObject({ kind: 'claude', sessionId: 's1' });
    });

    it('has none in the workstation-only build, and so never spawns', async () => {
        const source = getSideChatForkSource(session, true);
        expect(source).toBeNull();
        const spawn = vi.fn();
        await expect(spawnSideChatFrom(source, spawn, 'unavailable')).rejects.toThrow('unavailable');
        expect(spawn).not.toHaveBeenCalled();
    });

    it('spawns from a source', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'side-1' }));
        const source = getSideChatForkSource(session, false);
        await expect(spawnSideChatFrom(source, spawn, 'unavailable')).resolves.toEqual({ type: 'success', sessionId: 'side-1' });
        expect(spawn).toHaveBeenCalledWith(source);
    });
});
