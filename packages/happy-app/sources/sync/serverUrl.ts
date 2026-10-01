/**
 * Used only when neither a deploy-time (`window.__HAPPY_CONFIG__.serverUrl`) nor a
 * build-time (`EXPO_PUBLIC_HAPPY_SERVER_URL`) URL exists, i.e. local development
 * against the repo's docker-compose / `pnpm env` server. Deliberately not the
 * upstream hosted server: a misconfigured corporate build must fail closed.
 */
export const DEV_FALLBACK_SERVER_URL = 'http://localhost:3005';

export function resolveServerUrl(sources: { deployUrl?: unknown; buildUrl?: string }): string {
    const deployUrl = typeof sources.deployUrl === 'string' ? sources.deployUrl.trim() : '';
    const buildUrl = sources.buildUrl?.trim() ?? '';
    return (deployUrl || buildUrl || DEV_FALLBACK_SERVER_URL).replace(/\/+$/, '');
}
