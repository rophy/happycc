import type { AuthRouteDeps } from '@/app/api/routes/oidcRoutes';
import { log } from '@/utils/log';
import { loadAuthConfig } from './authConfig';
import { initAccessTokens } from './accessTokens';
import { initBrowserCookies } from './browserCookies';
import { createLazyOidcClient, createOidcClient } from './oidcClient';
import { createIdpCheck } from './idpCheck';

export type OidcRuntime = AuthRouteDeps;

let runtime: OidcRuntime | null = null;

/** Loads config, initializes token/cookie keys and starts IdP discovery. Call after initEncrypt(). */
export async function initOidcAuth(env: NodeJS.ProcessEnv = process.env): Promise<OidcRuntime> {
    const config = loadAuthConfig(env);
    initAccessTokens({ masterSecret: config.masterSecret, ttlSec: config.accessTokenTtlSec });
    initBrowserCookies({ masterSecret: config.masterSecret, secure: config.publicUrl.startsWith('https://') });
    // Config errors above fail fast; an unreachable IdP does not block startup.
    // Discovery is retried in the background and login routes answer 503 until it succeeds.
    const oidc = createLazyOidcClient(() => createOidcClient(
        {
            issuer: config.issuer,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            scopes: config.scopes,
            redirectUri: `${config.publicUrl}/v1/auth/oidc/callback`,
        },
        { allowInsecureRequests: config.allowInsecureIssuer },
    ));
    await oidc.firstAttempt;
    void oidc.ready.then(() => log({ module: 'auth' }, `OIDC auth ready (issuer ${config.issuer})`));
    if (!oidc.isReady()) {
        log({ module: 'auth', level: 'error' }, `IdP ${config.issuer} unreachable at startup; login unavailable until discovery succeeds`);
    }
    runtime = { config, oidc, checkIdp: createIdpCheck({ oidc }) };
    return runtime;
}

export function getOidcRuntime(): OidcRuntime {
    if (!runtime) {
        throw new Error('OIDC auth not initialized');
    }
    return runtime;
}
