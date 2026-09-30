import * as client from 'openid-client';
import { log } from '@/utils/log';

export interface OidcLoginParams {
    state: string;
    nonce: string;
    codeVerifier: string;
}

export interface OidcIdentity {
    issuer: string;
    subject: string;
    email: string | null;
    name: string | null;
    refreshToken: string | null;
}

export type IdpRefreshResult =
    | { status: 'ok'; refreshToken: string | null }
    | { status: 'rejected' }
    | { status: 'unavailable' };

export interface OidcClient {
    buildLoginUrl(params: OidcLoginParams): Promise<URL>;
    handleCallback(callbackUrl: URL, params: OidcLoginParams): Promise<OidcIdentity>;
    refresh(refreshToken: string): Promise<IdpRefreshResult>;
}

export function newLoginParams(): OidcLoginParams {
    return {
        state: client.randomState(),
        nonce: client.randomNonce(),
        codeVerifier: client.randomPKCECodeVerifier(),
    };
}

export async function createOidcClient(
    cfg: { issuer: string; clientId: string; clientSecret: string; scopes: string; redirectUri: string },
    opts: { allowInsecureRequests?: boolean } = {},
): Promise<OidcClient> {
    const config = await client.discovery(
        new URL(cfg.issuer),
        cfg.clientId,
        cfg.clientSecret,
        undefined,
        opts.allowInsecureRequests ? { execute: [client.allowInsecureRequests] } : undefined,
    );

    return {
        async buildLoginUrl(params) {
            return client.buildAuthorizationUrl(config, {
                redirect_uri: cfg.redirectUri,
                scope: cfg.scopes,
                code_challenge: await client.calculatePKCECodeChallenge(params.codeVerifier),
                code_challenge_method: 'S256',
                state: params.state,
                nonce: params.nonce,
            });
        },

        async handleCallback(callbackUrl, params) {
            const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
                pkceCodeVerifier: params.codeVerifier,
                expectedState: params.state,
                expectedNonce: params.nonce,
                idTokenExpected: true,
            });
            const claims = tokens.claims();
            if (!claims) {
                throw new Error('IdP returned no id_token');
            }
            return {
                issuer: claims.iss,
                subject: claims.sub,
                email: typeof claims.email === 'string' ? claims.email : null,
                name: typeof claims.name === 'string' ? claims.name : null,
                refreshToken: tokens.refresh_token ?? null,
            };
        },

        async refresh(refreshToken) {
            try {
                const tokens = await client.refreshTokenGrant(config, refreshToken);
                return { status: 'ok', refreshToken: tokens.refresh_token ?? null };
            } catch (error) {
                if (error instanceof client.ResponseBodyError && error.error === 'invalid_grant') {
                    return { status: 'rejected' };
                }
                const errorName = error instanceof Error ? error.constructor.name : String(error);
                const errorCode = (error as { error?: string; code?: string } | null)?.error
                    ?? (error as { error?: string; code?: string } | null)?.code;
                log(
                    { module: 'auth', level: 'error' },
                    `OIDC refresh failed with unexpected error: ${errorName}${errorCode ? ` (${errorCode})` : ''}`,
                );
                return { status: 'unavailable' };
            }
        },
    };
}
