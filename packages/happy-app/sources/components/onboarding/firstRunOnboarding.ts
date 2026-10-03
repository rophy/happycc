export function shouldShowFirstRunInstall({
    isAuthenticated,
    isDataReady,
    machineCount,
    isWeb,
    isRunningOnMac,
    workstationOnly = false,
    sessionCount = 0,
}: {
    isAuthenticated: boolean;
    isDataReady: boolean;
    machineCount: number;
    isWeb: boolean;
    isRunningOnMac: boolean;
    /** Workstation-only build: any session also means the workstation is linked. */
    workstationOnly?: boolean;
    sessionCount?: number;
}): boolean {
    return isAuthenticated
        && isDataReady
        && machineCount === 0
        && (!workstationOnly || sessionCount === 0)
        && !isWeb
        && !isRunningOnMac;
}

export function shouldSuppressTabletShell({
    isAuthenticated,
    isTablet,
    showInstallStep,
    isOnboardingRoute,
    isWeb,
    isRunningOnMac,
}: {
    isAuthenticated: boolean;
    isTablet: boolean;
    showInstallStep: boolean;
    isOnboardingRoute: boolean;
    isWeb: boolean;
    isRunningOnMac: boolean;
}): boolean {
    return isAuthenticated
        && isTablet
        && !isWeb
        && !isRunningOnMac
        && (showInstallStep || isOnboardingRoute);
}

export type HomeEmptyState =
    /** No computer linked: the link-your-computer checklist. */
    | 'link'
    /** Computers linked, none reachable: the offline variant of the checklist. */
    | 'offline'
    /** A computer is reachable, there is just nothing to show yet. */
    | 'no-sessions'
    /** There are sessions to list. */
    | 'list';

/**
 * Which of the home screen's states applies. An archive-only account with a
 * reachable machine lists its archive control rather than an empty state; with
 * no reachable machine the connection problem is the useful thing to show.
 */
export function resolveHomeEmptyState({
    visibleSessionCount,
    hasArchivedSessions,
    machineCount,
    onlineMachineCount,
    workstationOnly = false,
}: {
    visibleSessionCount: number;
    hasArchivedSessions: boolean;
    machineCount: number;
    onlineMachineCount: number;
    /**
     * Workstation-only build: there is no daemon, so no machine is ever online
     * and sessions connect on their own. Only sessions decide the state.
     */
    workstationOnly?: boolean;
}): HomeEmptyState {
    if (visibleSessionCount > 0) return 'list';
    if (workstationOnly) return hasArchivedSessions ? 'list' : 'no-sessions';
    if (machineCount === 0) return 'link';
    if (onlineMachineCount === 0) return 'offline';
    return hasArchivedSessions ? 'list' : 'no-sessions';
}

/**
 * The plaque above the session list: only when there is a list to sit above
 * and every linked computer is offline. With nothing listed the whole screen
 * already says so.
 */
export function shouldShowOfflineMachinesBanner({
    machineCount,
    onlineMachineCount,
    workstationOnly = false,
}: {
    machineCount: number;
    onlineMachineCount: number;
    /** Workstation-only build: machines are never online, so there is nothing to warn about. */
    workstationOnly?: boolean;
}): boolean {
    return !workstationOnly && machineCount > 0 && onlineMachineCount === 0;
}
