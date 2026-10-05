import { parseDuration } from '@/app/auth/oidc/authConfig';

/** The authorization webhook (docs/deployment.md, "Authorization"). Null when AUTHZ_WEBHOOK_URL is unset. */
export interface AuthzConfig {
    url: string;
    secret: string;
    cacheTtlMs: number;
    timeoutMs: number;
}

export function loadAuthzConfig(env: NodeJS.ProcessEnv): AuthzConfig | null {
    const url = env.AUTHZ_WEBHOOK_URL?.trim();
    if (!url) {
        return null;
    }
    const secret = env.AUTHZ_WEBHOOK_SECRET?.trim();
    if (!secret) {
        throw new Error('AUTHZ_WEBHOOK_SECRET is required when AUTHZ_WEBHOOK_URL is set');
    }
    if (!url.startsWith('https://') && env.AUTHZ_WEBHOOK_ALLOW_INSECURE !== 'true') {
        throw new Error('AUTHZ_WEBHOOK_URL must use https (set AUTHZ_WEBHOOK_ALLOW_INSECURE=true for local development)');
    }
    return {
        url,
        secret,
        cacheTtlMs: parseDuration(env.AUTHZ_WEBHOOK_CACHE_TTL ?? '60s') * 1000,
        timeoutMs: parseDuration(env.AUTHZ_WEBHOOK_TIMEOUT ?? '5s') * 1000,
    };
}
