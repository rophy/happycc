/**
 * Permission modes ranked from safest to most permissive, across agent
 * families. Same table as the CLI's ceiling (happycc caps every mode the app
 * asks for at the session's starting mode); here it decides what the picker
 * offers and what the app sends, so the app never asks for a mode the CLI
 * would refuse.
 */
const RANK: Record<string, number> = {
    plan: 0, 'read-only': 0,
    default: 1, auto: 1,
    acceptEdits: 2, 'safe-yolo': 2,
    bypassPermissions: 3, yolo: 3,
};

export function permissionModeRank(mode: string): number | undefined {
    return Object.prototype.hasOwnProperty.call(RANK, mode) ? RANK[mode] : undefined;
}

/**
 * The session's starting permission mode: the most permissive mode happycc
 * accepts from the app for it.
 *
 * happycc publishes it as `permissionModeCeiling`. Older CLIs do not; for
 * them the one start-time signal is `dangerouslySkipPermissions` (set for a
 * bypassPermissions / yolo or sandboxed start), and anything else counts as
 * `default`. The synced `permissionMode` pick is never used: any client can
 * write it, so it says nothing about how the session started.
 */
export function sessionStartingPermissionMode(
    metadata: { permissionModeCeiling?: string | null; dangerouslySkipPermissions?: boolean | null } | null | undefined,
): string {
    if (typeof metadata?.permissionModeCeiling === 'string' && metadata.permissionModeCeiling) {
        return metadata.permissionModeCeiling;
    }
    return metadata?.dangerouslySkipPermissions === true ? 'bypassPermissions' : 'default';
}

/**
 * The modes no more permissive than `ceiling`, in their original order.
 * Unranked modes are dropped (the CLI ignores them from the app); an unranked
 * ceiling counts as `default`.
 */
export function filterModesAtOrBelow<T extends { key: string }>(modes: readonly T[], ceiling: string): T[] {
    return modes.filter((mode) => isPermissionModeAllowed(mode.key, ceiling));
}

/**
 * Whether happycc would accept `mode` from the app for a session whose ceiling
 * is `ceiling`: ranked, and no more permissive than the ceiling (an unranked
 * ceiling counts as `default`).
 */
export function isPermissionModeAllowed(mode: string, ceiling: string): boolean {
    const limit = permissionModeRank(ceiling) ?? RANK.default;
    const rank = permissionModeRank(mode);
    return rank !== undefined && rank <= limit;
}

/**
 * The mode to show as current. A pick above the ceiling never reached the
 * session (happycc ignores it, and the app no longer sends it), so the
 * session is shown at its ceiling when that is on offer.
 */
export function resolveDisplayedPermissionMode<T extends { key: string }>(
    current: T | null,
    offered: readonly T[],
    ceiling: string,
): T | null {
    if (current && offered.some((mode) => mode.key === current.key)) return current;
    return offered.find((mode) => mode.key === ceiling) ?? null;
}

/**
 * What a session's composer offers and shows: modes at or below the session's
 * starting mode, with the current one consistent with that list. Rig sessions
 * are not run by happycc and keep their own catalog.
 */
export function capComposerPermissionModes<T extends { key: string }>({
    modes,
    current,
    metadata,
    isRig,
}: {
    modes: T[];
    current: T | null;
    metadata: Parameters<typeof sessionStartingPermissionMode>[0];
    isRig: boolean;
}): { availableModes: T[]; permissionMode: T | null } {
    if (isRig) return { availableModes: modes, permissionMode: current };
    const ceiling = sessionStartingPermissionMode(metadata);
    const availableModes = filterModesAtOrBelow(modes, ceiling);
    return { availableModes, permissionMode: resolveDisplayedPermissionMode(current, availableModes, ceiling) };
}
