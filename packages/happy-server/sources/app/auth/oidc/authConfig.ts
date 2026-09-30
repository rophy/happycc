export interface AuthConfig {
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
    publicUrl: string;
    webappUrl: string;
    mobileRedirectUris: string[];
    accessTokenTtlSec: number;
    maxSessionAgeSec: number;
    refreshReuseGraceSec: number;
    allowInsecureIssuer: boolean;
    masterSecret: string;
}

const MIN_MASTER_SECRET_LENGTH = 32;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value: string): number {
    const match = /^(\d+)([smhd])$/.exec(value.trim());
    if (!match) {
        throw new Error(`Invalid duration: ${value}`);
    }
    return parseInt(match[1], 10) * UNIT_SECONDS[match[2]];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function trimTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
    const masterSecret = required(env, 'HANDY_MASTER_SECRET');
    if (masterSecret.length < MIN_MASTER_SECRET_LENGTH) {
        throw new Error(`HANDY_MASTER_SECRET must be at least ${MIN_MASTER_SECRET_LENGTH} characters`);
    }
    const issuer = trimTrailingSlash(required(env, 'OIDC_ISSUER'));
    const allowInsecureIssuer = env.OIDC_ALLOW_INSECURE_ISSUER === 'true';
    if (!allowInsecureIssuer && !issuer.startsWith('https://')) {
        throw new Error('OIDC_ISSUER must use https (set OIDC_ALLOW_INSECURE_ISSUER=true for local development)');
    }
    return {
        issuer,
        clientId: required(env, 'OIDC_CLIENT_ID'),
        clientSecret: required(env, 'OIDC_CLIENT_SECRET'),
        scopes: env.OIDC_SCOPES?.trim() || 'openid profile email offline_access',
        publicUrl: trimTrailingSlash(required(env, 'PUBLIC_URL')),
        webappUrl: trimTrailingSlash(required(env, 'WEBAPP_URL')),
        mobileRedirectUris: (env.MOBILE_REDIRECT_URIS ?? '')
            .split(',')
            .map((uri) => uri.trim())
            .filter((uri) => uri.length > 0),
        accessTokenTtlSec: parseDuration(env.AUTH_ACCESS_TOKEN_TTL ?? '15m'),
        maxSessionAgeSec: parseDuration(env.AUTH_MAX_SESSION_AGE ?? '30d'),
        refreshReuseGraceSec: parseDuration(env.AUTH_REFRESH_REUSE_GRACE ?? '30s'),
        allowInsecureIssuer,
        masterSecret,
    };
}
