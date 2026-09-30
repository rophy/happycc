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
    /** False until IdP discovery has succeeded; login then throws IdpNotReadyError. */
    isReady(): boolean;
    buildLoginUrl(params: OidcLoginParams): Promise<URL>;
    handleCallback(callbackUrl: URL, params: OidcLoginParams): Promise<OidcIdentity>;
    refresh(refreshToken: string): Promise<IdpRefreshResult>;
}

/** Thrown by login operations while IdP discovery has not succeeded yet. */
export class IdpNotReadyError extends Error {
    constructor() {
        super('IdP discovery has not completed');
        this.name = 'IdpNotReadyError';
    }
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
        isReady() {
            return true;
        },

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

export interface LazyOidcClient extends OidcClient {
    /** Resolves after the first discovery attempt, whether or not it succeeded. */
    readonly firstAttempt: Promise<void>;
    /** Resolves once discovery has succeeded. */
    readonly ready: Promise<void>;
    /** Stops background retries. */
    stop(): void;
}

/**
 * An OidcClient whose discovery runs in the background and is retried with exponential
 * backoff until it succeeds, so the server can boot while the IdP is unreachable.
 * Until then login operations throw IdpNotReadyError and refresh reports 'unavailable'.
 */
export function createLazyOidcClient(
    connect: () => Promise<OidcClient>,
    opts: { initialDelayMs?: number; maxDelayMs?: number } = {},
): LazyOidcClient {
    const maxDelayMs = opts.maxDelayMs ?? 60_000;
    let delayMs = opts.initialDelayMs ?? 1_000;
    let inner: OidcClient | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveReady!: () => void;
    let resolveFirst!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const firstAttempt = new Promise<void>((resolve) => { resolveFirst = resolve; });

    const attempt = async () => {
        timer = null;
        try {
            inner = await connect();
            resolveReady();
        } catch (error) {
            const reason = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
            log({ module: 'auth', level: 'error' }, `IdP discovery failed (${reason}); retrying in ${delayMs} ms`);
            if (!stopped) {
                const retry = setTimeout(attempt, delayMs);
                (retry as { unref?: () => void }).unref?.();
                timer = retry;
                delayMs = Math.min(delayMs * 2, maxDelayMs);
            }
        } finally {
            resolveFirst();
        }
    };
    void attempt();

    return {
        firstAttempt,
        ready,
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
        isReady() {
            return inner !== null;
        },
        async buildLoginUrl(params) {
            if (!inner) throw new IdpNotReadyError();
            return inner.buildLoginUrl(params);
        },
        async handleCallback(callbackUrl, params) {
            if (!inner) throw new IdpNotReadyError();
            return inner.handleCallback(callbackUrl, params);
        },
        async refresh(refreshToken) {
            if (!inner) return { status: 'unavailable' };
            return inner.refresh(refreshToken);
        },
    };
}
