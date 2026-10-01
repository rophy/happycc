import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import { type Fastify } from '../types';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';
import type { OidcClient, OidcLoginParams } from '@/app/auth/oidc/oidcClient';
import { IdpNotReadyError, newLoginParams } from '@/app/auth/oidc/oidcClient';
import { AccountDisabledError, provisionAccount } from '@/app/auth/oidc/provisioning';
import { boxForRecipient, decodeEphemeralPublicKey } from '@/app/auth/oidc/accountKeys';
import { keyVault } from '@/app/auth/oidc/keyVault';
import { createDevice } from '@/app/auth/oidc/devices';
import { createExchangeCode, redeemExchangeCode } from '@/app/auth/oidc/exchangeCodes';
import { parseLoopbackRedirectUri } from '@/app/auth/oidc/loopbackRedirect';
import {
    CONFIRM_COOKIE, LOGIN_COOKIE, SESSION_COOKIE,
    clearCookieHeader, readCookie, setCookieHeader, signValue, verifyValue,
} from '@/app/auth/oidc/browserCookies';
import { idpUnavailablePage, loopbackConfirmPage, messagePage, mobileConfirmPage, sendHtml } from '@/app/auth/oidc/pages';

export interface AuthRouteDeps {
    config: AuthConfig;
    oidc: OidcClient;
    checkIdp: (accountId: string) => Promise<boolean>;
}

export type LoginTarget =
    | { kind: 'web'; appChallenge: string }
    | { kind: 'mobile'; appChallenge: string; redirectUri: string }
    | { kind: 'loopback'; appChallenge: string; redirectUri: string }
    | { kind: 'activate'; userCode: string | null };

interface LoginCookie extends OidcLoginParams {
    target: LoginTarget;
}

/**
 * Confirmable login targets: the loopback (happy-agent) and mobile flows both
 * gate code issuance behind an explicit tap, rather than handing a code
 * straight to whatever is listening on the redirect URI.
 */
type ConfirmTarget = 'loopback' | 'mobile';

/**
 * Pending loopback or mobile sign-in, held in a short-lived signed cookie
 * between the IdP callback and the user's confirm/deny decision. Never put in
 * a URL: it carries the account and PKCE challenge that would otherwise let
 * anyone who can get a victim to click a crafted login link steal a code.
 */
interface ConfirmPending {
    target: ConfirmTarget;
    accountId: string;
    appChallenge: string;
    redirectUri: string;
}

const LOGIN_COOKIE_TTL_SEC = 600;
export const SESSION_COOKIE_TTL_SEC = 600;
const CONFIRM_TTL_SEC = 300;
const CONFIRM_CSRF_PURPOSE: Record<ConfirmTarget, string> = {
    loopback: 'loopback-confirm-csrf',
    mobile: 'mobile-confirm-csrf',
};
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export function oidcRoutes(app: Fastify, deps: AuthRouteDeps) {
    const { config, oidc } = deps;

    // Browsers post the loopback confirm form as application/x-www-form-urlencoded.
    if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
        app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
            done(null, Object.fromEntries(new URLSearchParams(body as string)));
        });
    }

    app.get('/v1/auth/oidc/login', {
        schema: {
            querystring: z.object({
                client: z.enum(['web', 'mobile', 'loopback', 'activate']),
                code_challenge: z.string().optional(),
                redirect_uri: z.string().optional(),
                user_code: z.string().max(16).optional(),
            }),
        },
    }, async (request, reply) => {
        const query = request.query;
        let target: LoginTarget;
        if (query.client === 'activate') {
            target = { kind: 'activate', userCode: query.user_code ?? null };
        } else {
            if (!query.code_challenge || !PKCE_CHALLENGE.test(query.code_challenge)) {
                return reply.code(400).send({ error: 'code_challenge is required' });
            }
            if (query.client === 'mobile') {
                if (!query.redirect_uri || !config.mobileRedirectUris.includes(query.redirect_uri)) {
                    return reply.code(400).send({ error: 'redirect_uri is not allowed' });
                }
                target = { kind: 'mobile', appChallenge: query.code_challenge, redirectUri: query.redirect_uri };
            } else if (query.client === 'loopback') {
                const redirectUri = parseLoopbackRedirectUri(query.redirect_uri);
                if (!redirectUri) {
                    return reply.code(400).send({ error: 'redirect_uri is not allowed' });
                }
                target = { kind: 'loopback', appChallenge: query.code_challenge, redirectUri };
            } else {
                target = { kind: 'web', appChallenge: query.code_challenge };
            }
        }

        const params = newLoginParams();
        let loginUrl: URL;
        try {
            loginUrl = await oidc.buildLoginUrl(params);
        } catch (error) {
            if (error instanceof IdpNotReadyError) {
                return reply.code(503).send({ error: 'idp_unavailable' });
            }
            throw error;
        }
        const cookie: LoginCookie = { ...params, target };
        reply.header('set-cookie', setCookieHeader(LOGIN_COOKIE, cookie, LOGIN_COOKIE_TTL_SEC));
        return reply.redirect(loginUrl.toString());
    });

    app.get('/v1/auth/oidc/callback', async (request, reply) => {
        const html = (code: number, title: string, message: string) => {
            reply.header('set-cookie', clearCookieHeader(LOGIN_COOKIE));
            return sendHtml(reply, code, messagePage(title, message));
        };

        if (!oidc.isReady()) {
            return sendHtml(reply, 503, idpUnavailablePage());
        }
        const login = readCookie<LoginCookie>(request.headers.cookie, LOGIN_COOKIE);
        if (!login) {
            return html(400, 'Sign-in expired', 'Your sign-in took too long or was started in another browser. Please start again.');
        }
        const rawUrl = request.raw.url ?? '';
        const queryStart = rawUrl.indexOf('?');
        const rawQuery = queryStart === -1 ? '' : rawUrl.slice(queryStart + 1);
        if (new URLSearchParams(rawQuery).has('error')) {
            return html(400, 'Sign-in failed', 'Your identity provider did not complete the sign-in. Please try again.');
        }

        let accountId: string;
        try {
            const identity = await oidc.handleCallback(new URL(`${config.publicUrl}/v1/auth/oidc/callback?${rawQuery}`), login);
            ({ accountId } = await provisionAccount(identity));
        } catch (error) {
            if (error instanceof IdpNotReadyError) {
                return sendHtml(reply, 503, idpUnavailablePage());
            }
            if (error instanceof AccountDisabledError) {
                return html(403, 'Account disabled', 'Your account has been disabled. Contact your administrator.');
            }
            log({ module: 'auth', level: 'warn' }, `OIDC callback failed: ${error instanceof Error ? error.message : String(error)}`);
            return html(400, 'Sign-in failed', 'We could not verify your sign-in. Please try again.');
        }

        const target = login.target;
        if (target.kind === 'activate') {
            reply.header('set-cookie', [
                clearCookieHeader(LOGIN_COOKIE),
                setCookieHeader(SESSION_COOKIE, { accountId }, SESSION_COOKIE_TTL_SEC),
            ]);
            return reply.redirect(target.userCode ? `/activate?code=${encodeURIComponent(target.userCode)}` : '/activate');
        }

        if (target.kind === 'loopback' || target.kind === 'mobile') {
            const pending: ConfirmPending = {
                target: target.kind,
                accountId,
                appChallenge: target.appChallenge,
                redirectUri: target.redirectUri,
            };
            reply.header('set-cookie', [
                clearCookieHeader(LOGIN_COOKIE),
                setCookieHeader(CONFIRM_COOKIE, pending, CONFIRM_TTL_SEC),
            ]);
            return reply.redirect(`/v1/auth/oidc/${target.kind}/confirm`);
        }

        const code = await createExchangeCode({ accountId, clientKind: target.kind, pkceChallenge: target.appChallenge });
        reply.header('set-cookie', clearCookieHeader(LOGIN_COOKIE));
        return reply.redirect(`${config.webappUrl}/auth/callback#code=${encodeURIComponent(code)}`);
    });

    /**
     * Confirmation gate for the loopback (happy-agent) and mobile login
     * targets. Without it, anyone could send a victim a crafted
     * `/v1/auth/oidc/login?client=loopback&redirect_uri=http://127.0.0.1:<attacker port>/callback`
     * (or the mobile equivalent with an allowed custom-scheme redirect_uri)
     * link; a victim with a silent IdP session would deliver a code straight
     * to the attacker's listener. The pending account/challenge/redirect never
     * appears in a URL — only in the signed `CONFIRM_COOKIE` set by the
     * callback above — and the decision is CSRF-protected the same way
     * `/activate`'s confirm step is, with the token bound to the account,
     * redirect and PKCE challenge so it can't be replayed against another
     * pending sign-in.
     */
    function registerConfirmRoutes(target: ConfirmTarget) {
        const path = `/v1/auth/oidc/${target}/confirm`;
        const csrfPurpose = CONFIRM_CSRF_PURPOSE[target];

        app.get(path, async (request, reply) => {
            const pending = readCookie<ConfirmPending>(request.headers.cookie, CONFIRM_COOKIE);
            if (!pending || pending.target !== target) {
                return sendHtml(reply, 400, messagePage('Sign-in expired', 'Your sign-in took too long or was started in another browser. Please start again.'));
            }
            const csrf = signValue(csrfPurpose, { accountId: pending.accountId, redirectUri: pending.redirectUri, appChallenge: pending.appChallenge }, CONFIRM_TTL_SEC);
            if (target === 'loopback') {
                const port = new URL(pending.redirectUri).port;
                return sendHtml(reply, 200, loopbackConfirmPage({ port, csrf }));
            }
            return sendHtml(reply, 200, mobileConfirmPage({ appName: config.mobileAppName, csrf }));
        });

        app.post(path, {
            schema: {
                body: z.object({
                    csrf: z.string().max(2048),
                    decision: z.enum(['allow', 'deny']),
                }),
            },
        }, async (request, reply) => {
            const pending = readCookie<ConfirmPending>(request.headers.cookie, CONFIRM_COOKIE);
            if (!pending || pending.target !== target) {
                return sendHtml(reply, 401, messagePage('Sign-in expired', 'Please start again.'));
            }
            const csrf = verifyValue<{ accountId: string; redirectUri: string; appChallenge: string }>(csrfPurpose, request.body.csrf);
            if (!csrf || csrf.accountId !== pending.accountId || csrf.redirectUri !== pending.redirectUri || csrf.appChallenge !== pending.appChallenge) {
                return sendHtml(reply, 403, messagePage('Request rejected', 'This approval form is no longer valid. Please start again.'));
            }
            reply.header('set-cookie', clearCookieHeader(CONFIRM_COOKIE));
            if (request.body.decision === 'deny') {
                return reply.redirect(`${pending.redirectUri}?error=access_denied`);
            }
            const code = await createExchangeCode({
                accountId: pending.accountId,
                clientKind: target === 'loopback' ? 'agent' : 'mobile',
                pkceChallenge: pending.appChallenge,
            });
            return reply.redirect(`${pending.redirectUri}?code=${encodeURIComponent(code)}`);
        });
    }

    registerConfirmRoutes('loopback');
    registerConfirmRoutes('mobile');

    app.post('/v1/auth/oidc/exchange', {
        schema: {
            body: z.object({
                code: z.string().max(256),
                codeVerifier: z.string().max(256),
                ephemeralPublicKey: z.string().max(128),
                deviceName: z.string().max(100).optional(),
            }),
        },
    }, async (request, reply) => {
        const ephemeral = decodeEphemeralPublicKey(request.body.ephemeralPublicKey);
        if (!ephemeral) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        const redeemed = await redeemExchangeCode(request.body.code, request.body.codeVerifier);
        if (!redeemed) {
            return reply.code(400).send({ error: 'invalid_grant' });
        }
        const account = await db.account.findUniqueOrThrow({ where: { id: redeemed.accountId } });
        if (account.disabledAt) {
            return reply.code(400).send({ error: 'invalid_grant' });
        }
        let rootSecret: Uint8Array;
        try {
            rootSecret = keyVault.unwrap(account.wrappedRootSecret!);
        } catch {
            log({ module: 'auth', level: 'error' }, `ALERT: cannot unwrap root secret for account ${account.id}`);
            return reply.code(500).send({ error: 'server_error' });
        }
        const device = await createDevice({
            accountId: account.id,
            kind: redeemed.clientKind,
            name: request.body.deviceName ?? redeemed.clientKind,
        });
        return reply.send({
            accountId: account.id,
            accessToken: device.accessToken,
            refreshToken: device.refreshToken,
            keyBundle: privacyKit.encodeBase64(new Uint8Array(boxForRecipient(rootSecret, ephemeral))),
        });
    });
}
