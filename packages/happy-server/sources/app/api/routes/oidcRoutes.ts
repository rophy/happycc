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
import { LOGIN_COOKIE, SESSION_COOKIE, clearCookieHeader, readCookie, setCookieHeader } from '@/app/auth/oidc/browserCookies';
import { idpUnavailablePage, messagePage, sendHtml } from '@/app/auth/oidc/pages';

export interface AuthRouteDeps {
    config: AuthConfig;
    oidc: OidcClient;
    checkIdp: (accountId: string) => Promise<boolean>;
}

export type LoginTarget =
    | { kind: 'web'; appChallenge: string }
    | { kind: 'mobile'; appChallenge: string; redirectUri: string }
    | { kind: 'activate'; userCode: string | null };

interface LoginCookie extends OidcLoginParams {
    target: LoginTarget;
}

const LOGIN_COOKIE_TTL_SEC = 600;
export const SESSION_COOKIE_TTL_SEC = 600;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export function oidcRoutes(app: Fastify, deps: AuthRouteDeps) {
    const { config, oidc } = deps;

    app.get('/v1/auth/oidc/login', {
        schema: {
            querystring: z.object({
                client: z.enum(['web', 'mobile', 'activate']),
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
        const rawQuery = (request.raw.url ?? '').split('?')[1] ?? '';
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

        const code = await createExchangeCode({ accountId, clientKind: target.kind, pkceChallenge: target.appChallenge });
        reply.header('set-cookie', clearCookieHeader(LOGIN_COOKIE));
        if (target.kind === 'mobile') {
            return reply.redirect(`${target.redirectUri}?code=${encodeURIComponent(code)}`);
        }
        return reply.redirect(`${config.webappUrl}/auth/callback#code=${encodeURIComponent(code)}`);
    });

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
