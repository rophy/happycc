/** A fixed token (tests, one-shot commands) or a live getter (tokenStore.current). */
export type AccessTokenSource = string | (() => string);

export function resolveAccessToken(source: AccessTokenSource): string {
    return typeof source === 'function' ? source() : source;
}

/**
 * Resolves the token used for a socket handshake (connect / reconnect). Prefers
 * an async getter (e.g. tokenStore.getAccessToken, which checks wall-clock
 * expiry and refreshes before the timer fires) when one is supplied; falls
 * back to the plain sync `AccessTokenSource` otherwise (tests, one-shot use).
 */
export async function resolveSocketAuthToken(
    source: AccessTokenSource,
    getAccessToken?: () => Promise<string>,
): Promise<string> {
    return getAccessToken ? getAccessToken() : resolveAccessToken(source);
}
