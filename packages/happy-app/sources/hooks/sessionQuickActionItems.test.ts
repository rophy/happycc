import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import { buildSessionActionItems, getResumeAvailability, resolveCanFork } from './sessionQuickActionItems';
import type { Machine, Session } from '@/sync/storageTypes';

const noop = () => {};
const handlers = {
    openDetails: noop,
    resumeSession: noop,
    forkSession: noop,
    openDuplicateSheet: noop,
    copySessionMetadata: noop,
    copySessionMetadataAndLogs: noop,
    archiveSession: noop,
};

const session = {
    id: 's1',
    metadata: { machineId: 'm1', path: '/w', host: 'h', claudeSessionId: 'c1' },
} as unknown as Session;
const onlineMachine = { id: 'm1', active: true, metadata: { resumeSupport: { rpcAvailable: true } } } as unknown as Machine;

describe('session quick actions', () => {
    it('offers resume, fork and duplicate when the build allows starting sessions', () => {
        const resume = getResumeAvailability(session, onlineMachine, false, false);
        expect(resume.canShowResume).toBe(true);
        const canFork = resolveCanFork({ workstationOnly: false, experimentsEnabled: true, isRig: false, hasForkSource: true, machine: onlineMachine });
        expect(canFork).toBe(true);
        const ids = buildSessionActionItems({ canShowResume: resume.canShowResume, canFork, canCopySessionMetadata: false, ...handlers }).map((item) => item.id);
        expect(ids).toEqual(['details', 'resume', 'fork', 'duplicate', 'archive']);
    });

    it('omits resume, fork and duplicate in the workstation-only build', () => {
        const resume = getResumeAvailability(session, onlineMachine, false, true);
        expect(resume).toMatchObject({ canResume: false, canShowResume: false });
        const canFork = resolveCanFork({ workstationOnly: true, experimentsEnabled: true, isRig: false, hasForkSource: true, machine: onlineMachine });
        expect(canFork).toBe(false);
        const ids = buildSessionActionItems({ canShowResume: resume.canShowResume, canFork, canCopySessionMetadata: true, ...handlers }).map((item) => item.id);
        expect(ids).toEqual(['details', 'copy-metadata', 'copy-metadata-and-logs', 'archive']);
    });

    it('hides resume even for a session with no machine in the workstation-only build', () => {
        const orphan = { id: 's2', metadata: { path: '/w', host: 'h' } } as unknown as Session;
        expect(getResumeAvailability(orphan, null, false, false).canShowResume).toBe(true);
        expect(getResumeAvailability(orphan, null, false, true).canShowResume).toBe(false);
    });
});
