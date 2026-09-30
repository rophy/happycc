import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PrismaClient } from '@prisma/client';
import type { Fastify } from '@/app/api/types';
import type { AuthConfig } from '@/app/auth/oidc/authConfig';
import type { IdpRefreshResult, OidcClient, OidcIdentity } from '@/app/auth/oidc/oidcClient';
import { createTestDb } from './testDb';

export const TEST_ENV = {
    OIDC_ISSUER: 'https://idp.test',
    OIDC_CLIENT_ID: 'happy-server',
    OIDC_CLIENT_SECRET: 'secret',
    PUBLIC_URL: 'https://happy.test',
    WEBAPP_URL: 'https://app.test',
    MOBILE_REDIRECT_URIS: 'corpapp://auth/callback',
    HANDY_MASTER_SECRET: 'test-master-secret-that-is-long-enough-000',
};

export interface FakeOidc {
    client: OidcClient;
    queueIdentity(identity: OidcIdentity): void;
    setRefreshResult(result: IdpRefreshResult): void;
    readonly refreshCalls: number;
}

export function createFakeOidc(): FakeOidc {
    const identities: OidcIdentity[] = [];
    let refreshResult: IdpRefreshResult = { status: 'ok', refreshToken: null };
    let refreshCalls = 0;
    return {
        client: {
            async buildLoginUrl(params) {
                const url = new URL('https://idp.test/authorize');
                url.searchParams.set('state', params.state);
                return url;
            },
            async handleCallback(callbackUrl, params) {
                if (callbackUrl.searchParams.get('state') !== params.state) {
                    throw new Error('state mismatch');
                }
                const identity = identities.shift();
                if (!identity) {
                    throw new Error('no identity queued');
                }
                return identity;
            },
            async refresh() {
                refreshCalls++;
                return refreshResult;
            },
        },
        queueIdentity(identity) { identities.push(identity); },
        setRefreshResult(result) { refreshResult = result; },
        get refreshCalls() { return refreshCalls; },
    };
}

/** Test DB + encryption + token/cookie keys, all bound to TEST_ENV. */
export async function setupAuthTest(): Promise<{ db: PrismaClient; config: AuthConfig; fake: FakeOidc }> {
    Object.assign(process.env, TEST_ENV);
    const db = await createTestDb();
    await (await import('@/modules/encrypt')).initEncrypt();
    const { loadAuthConfig } = await import('@/app/auth/oidc/authConfig');
    const config = loadAuthConfig(TEST_ENV);
    (await import('@/app/auth/oidc/accessTokens')).initAccessTokens({ masterSecret: config.masterSecret, ttlSec: config.accessTokenTtlSec });
    (await import('@/app/auth/oidc/browserCookies')).initBrowserCookies({ masterSecret: config.masterSecret, secure: true });
    return { db, config, fake: createFakeOidc() };
}

export async function buildTestApp(register: (app: Fastify) => void): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    const { enableAuthentication } = await import('@/app/api/utils/enableAuthentication');
    enableAuthentication(typed);
    register(typed);
    await typed.ready();
    return typed;
}

/** Turns a response's Set-Cookie headers into a Cookie request header. */
export function cookieHeader(res: { headers: Record<string, unknown> }): string {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
    return list.map((c) => String(c).split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}
