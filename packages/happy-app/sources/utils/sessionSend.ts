/**
 * In a workstation-only build, a stopped session cannot take messages: nothing on the workstation is
 * running to receive them, and `happycc resume` reattaches without replaying what is already stored,
 * so a message sent meanwhile would be silently lost. The session's own `active` flag (false once its
 * process ended, not during a brief network drop) decides; the inactive hint shows how to resume it.
 */
export function isSendBlockedForStoppedSession(
    session: { active: boolean } | null | undefined,
    workstationOnly: boolean,
): boolean {
    return workstationOnly && !!session && session.active === false;
}
