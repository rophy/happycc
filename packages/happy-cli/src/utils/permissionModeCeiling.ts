/**
 * Permission modes ranked from safest to most permissive, across agent families.
 * A session's starting mode is its ceiling: the app may lower it, never raise it.
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

export function capPermissionMode(requested: string, ceiling: string | undefined): { mode: string; capped: boolean } {
    const limit = ceiling ?? 'default';
    const requestedRank = permissionModeRank(requested);
    const limitRank = permissionModeRank(limit) ?? RANK.default;
    if (requestedRank === undefined || requestedRank > limitRank) {
        return { mode: limit, capped: true };
    }
    return { mode: requested, capped: false };
}
