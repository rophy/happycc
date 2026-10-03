/**
 * Permission modes ranked from safest to most permissive, across agent
 * families. Same table as the CLI's ceiling (happycc caps every mode the app
 * asks for at the session's starting mode); here it decides what the picker
 * offers and what the app sends, so the app never asks for a mode the CLI
 * would refuse.
 */
const RANK: Record<string, number> = {
    plan: 0, 'read-only': 0,
    default: 1,
    auto: 2, // runs tools without prompting: above default
    acceptEdits: 3, 'safe-yolo': 3,
    bypassPermissions: 4, yolo: 4,
};

/**
 * The modes happycc maps for a Claude session before applying them (its
 * mapToClaudeMode); the ceiling compares the mapped modes, since that is what
 * the session actually runs (`read-only` runs as `default`, so it is not below
 * a plan start).
 */
const CLAUDE_MODE_MAP: Record<string, string> = {
    yolo: 'bypassPermissions',
    'safe-yolo': 'default',
    'read-only': 'default',
};

type CeilingMetadata = {
    permissionModeCeiling?: string | null;
    dangerouslySkipPermissions?: boolean | null;
    flavor?: string | null;
} | null | undefined;

/** Whether the session runs Claude, whose modes happycc maps before applying (no flavor = Claude). */
export function usesClaudeModeMapping(metadata: CeilingMetadata): boolean {
    return !metadata?.flavor || metadata.flavor === 'claude';
}

function toApplied(mode: string, claude: boolean): string {
    return claude && Object.prototype.hasOwnProperty.call(CLAUDE_MODE_MAP, mode) ? CLAUDE_MODE_MAP[mode] : mode;
}

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
export function sessionStartingPermissionMode(metadata: CeilingMetadata): string {
    if (typeof metadata?.permissionModeCeiling === 'string' && metadata.permissionModeCeiling) {
        return metadata.permissionModeCeiling;
    }
    return metadata?.dangerouslySkipPermissions === true ? 'bypassPermissions' : 'default';
}

/**
 * The modes no more permissive than `ceiling`, in their original order.
 * Unranked modes are dropped (the CLI ignores them from the app); an unranked
 * ceiling counts as `default`. `claude` compares the modes as a Claude session
 * applies them.
 */
export function filterModesAtOrBelow<T extends { key: string }>(modes: readonly T[], ceiling: string, claude = false): T[] {
    return modes.filter((mode) => isPermissionModeAllowed(mode.key, ceiling, claude));
}

/**
 * Whether happycc would accept `mode` from the app for a session whose ceiling
 * is `ceiling`: ranked, and no more permissive than the ceiling (an unranked
 * ceiling counts as `default`). `claude` compares the modes as a Claude
 * session applies them (see CLAUDE_MODE_MAP).
 */
export function isPermissionModeAllowed(mode: string, ceiling: string, claude = false): boolean {
    const limit = permissionModeRank(toApplied(ceiling, claude)) ?? RANK.default;
    const rank = permissionModeRank(toApplied(mode, claude));
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
    const claude = usesClaudeModeMapping(metadata);
    const availableModes = filterModesAtOrBelow(modes, ceiling, claude);
    return {
        availableModes,
        permissionMode: resolveDisplayedPermissionMode(current, availableModes, toApplied(ceiling, claude)),
    };
}
