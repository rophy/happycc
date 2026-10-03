import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineBash = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ workstationOnly: true }));

vi.mock('@/sync/ops', () => ({ machineBash }));
vi.mock('@/config', () => ({
    get workstationOnly() { return flags.workstationOnly; },
    config: {},
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ getActiveSessions: () => [] }) } }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { createWorktree, listWorktrees, removeWorktree } from './worktree';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';

const WORKTREE = '/repo/.dev/worktree/clever-ocean';

describe('worktree shell calls in the workstation-only build', () => {
    beforeEach(() => {
        machineBash.mockReset();
        machineBash.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });

    it('never runs a command on the machine', async () => {
        flags.workstationOnly = true;
        expect((await createWorktree('m1', '/repo')).success).toBe(false);
        expect(await listWorktrees('m1', '/repo')).toEqual([]);
        expect((await removeWorktree('m1', WORKTREE)).success).toBe(false);
        await maybeCleanupWorktree('s1', WORKTREE, 'm1');
        expect(machineBash).not.toHaveBeenCalled();
    });

    it('still runs them when the build allows machine use', async () => {
        flags.workstationOnly = false;
        await listWorktrees('m1', '/repo');
        await removeWorktree('m1', WORKTREE);
        await maybeCleanupWorktree('s1', WORKTREE, 'm1');
        expect(machineBash).toHaveBeenCalled();
    });
});
