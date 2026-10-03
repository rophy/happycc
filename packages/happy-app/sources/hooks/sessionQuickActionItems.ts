import type { Machine, Session } from '@/sync/storageTypes';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { isRigMetadata } from '@/sync/rig';
import { isMachineOnline } from '@/utils/machineUtils';
import { t } from '@/text';

export interface SessionActionItem {
    id: SessionActionShortcutId;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

export type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

const NO_RESUME: ResumeAvailability = Object.freeze({ canResume: false, canShowResume: false, subtitle: '', message: '' });

/**
 * Whether the session offers Resume, and why not. The workstation-only build
 * never resumes a session from the app: it starts on the workstation.
 */
export function getResumeAvailability(
    session: Session,
    machine: Machine | null | undefined,
    isConnected: boolean,
    workstationOnly: boolean,
): ResumeAvailability {
    if (workstationOnly) {
        return NO_RESUME;
    }
    if (isRigMetadata(session.metadata) || session.metadata?.capabilities?.resume === false) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    // Older daemons do not publish resumeSupport and do not implement the
    // resume RPC. Capability presence is the compatibility check; the UI is
    // hidden instead of offering an action that the machine cannot execute.
    if (machine.metadata?.resumeSupport?.rpcAvailable !== true) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
}

/**
 * Fork and duplicate both start a new session on the session's machine, so the
 * workstation-only build never offers them.
 */
export function resolveCanFork({
    workstationOnly,
    experimentsEnabled,
    isRig,
    hasForkSource,
    machine,
}: {
    workstationOnly: boolean;
    experimentsEnabled: boolean;
    isRig: boolean;
    hasForkSource: boolean;
    machine: Machine | null | undefined;
}): boolean {
    return Boolean(
        !workstationOnly
        && experimentsEnabled
        && !isRig
        && hasForkSource
        && machine
        && isMachineOnline(machine)
    );
}

/** The session's action menu (popover, long-press alert, keyboard shortcuts), in display order. */
export function buildSessionActionItems({
    canShowResume,
    canFork,
    canCopySessionMetadata,
    openDetails,
    resumeSession,
    forkSession,
    openDuplicateSheet,
    copySessionMetadata,
    copySessionMetadataAndLogs,
    archiveSession,
}: {
    canShowResume: boolean;
    canFork: boolean;
    canCopySessionMetadata: boolean;
    openDetails: () => void;
    resumeSession: () => void;
    forkSession: () => void;
    openDuplicateSheet: () => void;
    copySessionMetadata: () => void;
    copySessionMetadataAndLogs: () => void;
    archiveSession: () => void;
}): SessionActionItem[] {
    const items: SessionActionItem[] = [
        { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
    ];

    if (canShowResume) {
        items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
    }

    if (canFork) {
        items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
        items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
    }

    if (canCopySessionMetadata) {
        items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
        items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
    }

    items.push({ id: 'archive', icon: 'archive-outline', label: t('session.archiveAction'), onPress: archiveSession, destructive: true });

    return items;
}
