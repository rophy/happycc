/**
 * Permission modes ranked from safest to most permissive, across agent
 * families. Same table as the CLI's ceiling (happycc caps every mode the app
 * asks for at the session's starting mode); here it only decides what the
 * picker offers, so the app never offers a mode the CLI would refuse.
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
 * The session's starting permission mode as far as the app can tell.
 *
 * The CLI publishes no starting mode; the one thing its session metadata says
 * about it is `dangerouslySkipPermissions`, set when the session started in
 * bypassPermissions / yolo (Claude, Codex) or in the sandbox. Anything else is
 * treated as `default`. The synced `permissionMode` pick is not used: any
 * client can write it, so it says nothing about how the session started.
 */
export function sessionStartingPermissionMode(
    metadata: { dangerouslySkipPermissions?: boolean | null } | null | undefined,
): string {
    return metadata?.dangerouslySkipPermissions === true ? 'bypassPermissions' : 'default';
}

/**
 * A picker option's rank: its key, or the semantic kind some agents publish
 * beside an opaque code (e.g. code `auto`, kind `safe-yolo`). With both, the
 * more permissive one counts.
 */
function optionRank(mode: { key: string; semanticKind?: string | null }): number | undefined {
    const byKey = permissionModeRank(mode.key);
    const byKind = mode.semanticKind ? permissionModeRank(mode.semanticKind) : undefined;
    if (byKey === undefined) return byKind;
    if (byKind === undefined) return byKey;
    return Math.max(byKey, byKind);
}

/**
 * The modes no more permissive than `ceiling`, in their original order.
 * Unranked modes are dropped (the CLI ignores them from the app); an unranked
 * ceiling counts as `default`.
 */
export function filterModesAtOrBelow<T extends { key: string; semanticKind?: string | null }>(modes: readonly T[], ceiling: string): T[] {
    const limit = permissionModeRank(ceiling) ?? RANK.default;
    return modes.filter((mode) => {
        const rank = optionRank(mode);
        return rank !== undefined && rank <= limit;
    });
}
