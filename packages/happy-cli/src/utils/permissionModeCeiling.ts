/**
 * Permission modes ranked from safest to most permissive, across agent families.
 * A session's starting mode is its ceiling: the app may lower it, never raise it.
 * `auto` runs tools without prompting, so it ranks above `default`.
 */
const RANK: Record<string, number> = {
    plan: 0, 'read-only': 0,
    default: 1,
    auto: 2,
    acceptEdits: 3, 'safe-yolo': 3,
    bypassPermissions: 4, yolo: 4,
};

export function permissionModeRank(mode: string): number | undefined {
    return Object.prototype.hasOwnProperty.call(RANK, mode) ? RANK[mode] : undefined;
}

export type PermissionModeCapResult =
    | { mode: string; capped: false }
    | { mode: string; capped: true; reason: 'above-ceiling' | 'unranked' };

/** The notice shown to the user when the app's requested mode is not applied. */
export function permissionModeCapNotice(requested: string, result: PermissionModeCapResult): string {
    return result.capped && result.reason === 'unranked'
        ? `Ignored a request from the app to change the permission mode to ${requested}: this agent's modes cannot be changed from the app.`
        : `Ignored a request from the app to raise the permission mode to ${requested}.`;
}

export function capPermissionMode(requested: string, ceiling: string | undefined): PermissionModeCapResult {
    const limit = ceiling ?? 'default';
    const requestedRank = permissionModeRank(requested);
    const limitRank = permissionModeRank(limit) ?? RANK.default;
    if (requestedRank === undefined) {
        return { mode: limit, capped: true, reason: 'unranked' };
    }
    if (requestedRank > limitRank) {
        return { mode: limit, capped: true, reason: 'above-ceiling' };
    }
    return { mode: requested, capped: false };
}

export type AppPermissionModeDecision =
    | { kind: 'apply'; mode: string }
    | { kind: 'refuse'; notice: string }
    | { kind: 'unsupported' };

/**
 * What a runner does with a permission mode the app asks for: modes the agent
 * does not support are dropped, modes above the starting mode are refused with
 * a notice for the user, and the rest are applied.
 */
export function decideAppPermissionMode(
    requested: string,
    startingMode: string,
    isSupported: (mode: string) => boolean,
): AppPermissionModeDecision {
    if (!isSupported(requested)) {
        return { kind: 'unsupported' };
    }
    const result = capPermissionMode(requested, startingMode);
    if (result.capped) {
        return { kind: 'refuse', notice: permissionModeCapNotice(requested, result) };
    }
    return { kind: 'apply', mode: requested };
}
