/** ID token claims that describe the token itself, not the user: never stored or forwarded. */
const TOKEN_CLAIMS = new Set(['iss', 'sub', 'aud', 'exp', 'iat', 'nonce', 'at_hash', 'auth_time']);

/** The user's ID token claims as stored per account and forwarded to the authorization webhook. */
export function filterIdpClaims(claims: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(claims).filter(([key]) => !TOKEN_CLAIMS.has(key)));
}
