/** A fixed token (tests, one-shot commands) or a live getter (tokenStore.current). */
export type AccessTokenSource = string | (() => string);

export function resolveAccessToken(source: AccessTokenSource): string {
    return typeof source === 'function' ? source() : source;
}
