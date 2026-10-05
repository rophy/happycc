/** The server's denial payload ({ error: 'forbidden', reason? }): its reason, or undefined if `data` is not one. */
export function forbiddenReason(data: unknown): string | null | undefined {
    const value = data as { error?: unknown; reason?: unknown } | null | undefined;
    if (value?.error !== 'forbidden') {
        return undefined;
    }
    return typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : null;
}

export function notAuthorizedMessage(reason: string | null): string {
    return `Not authorized: ${reason ?? 'your organization has not given you access.'}`;
}
