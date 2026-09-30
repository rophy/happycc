import type { AuthRouteDeps } from '@/app/api/routes/oidcRoutes';
import { log } from '@/utils/log';
import { loadAuthConfig } from './authConfig';
import { initAccessTokens } from './accessTokens';
import { initBrowserCookies } from './browserCookies';
import { createOidcClient } from './oidcClient';
import { createIdpCheck } from './idpCheck';

export type OidcRuntime = AuthRouteDeps;

let runtime: OidcRuntime | null = null;

/** Loads config, initializes token/cookie keys and discovers the IdP. Call after initEncrypt(). */
export async function initOidcAuth(env: NodeJS.ProcessEnv = process.env): Promise<OidcRuntime> {
    const config = loadAuthConfig(env);
    initAccessTokens({ masterSecret: config.masterSecret, ttlSec: config.accessTokenTtlSec });
    initBrowserCookies({ masterSecret: config.masterSecret, secure: config.publicUrl.startsWith('https://') });
    const oidc = await createOidcClient(
        {
            issuer: config.issuer,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            scopes: config.scopes,
            redirectUri: `${config.publicUrl}/v1/auth/oidc/callback`,
        },
        { allowInsecureRequests: config.allowInsecureIssuer },
    );
    runtime = { config, oidc, checkIdp: createIdpCheck({ oidc }) };
    log({ module: 'auth' }, `OIDC auth ready (issuer ${config.issuer})`);
    return runtime;
}

export function getOidcRuntime(): OidcRuntime {
    if (!runtime) {
        throw new Error('OIDC auth not initialized');
    }
    return runtime;
}
