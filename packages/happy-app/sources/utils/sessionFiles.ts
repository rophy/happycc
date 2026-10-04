/**
 * Which desktop file features a build offers. A workstation-only build keeps the git views (changes,
 * diffs) but drops the desktop "All files" browser and file editing: both read or write the workstation
 * outside the agent's permission prompts, and the CLI refuses session-scoped writes in this build.
 */

/** Whether a right-sidebar panel can be opened. */
export function isSidebarPanelAvailable(panel: string, workstationOnly: boolean): boolean {
    return !(workstationOnly && panel === 'allFiles');
}

/** Whether the file viewer may offer editing, given the session's own write capability. */
export function canEditSessionFiles(sessionCanWrite: boolean, workstationOnly: boolean): boolean {
    return sessionCanWrite && !workstationOnly;
}
