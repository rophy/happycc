import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const { authMock, githubConnectMock } = vi.hoisted(() => ({
    authMock: {
        createGithubToken: vi.fn(async () => 'state-1'),
        verifyGithubToken: vi.fn(async (state: string) => (state === 'state-1' ? { userId: 'user-1' } : null)),
    },
    githubConnectMock: vi.fn(async () => undefined),
}));

vi.mock("@/app/auth/auth", () => ({ auth: authMock }));
vi.mock("@/app/github/githubConnect", () => ({ githubConnect: githubConnectMock }));
vi.mock("@/app/github/githubDisconnect", () => ({ githubDisconnect: vi.fn(async () => undefined) }));
vi.mock("@/context", () => ({ Context: { create: (uid: string) => ({ uid }) } }));

import { githubRoutes, webappRedirectUrl } from "./githubRoutes";

const github = {
    clientId: 'gh-client',
    clientSecret: 'gh-secret',
    redirectUrl: 'https://happy.corp.example/v1/connect/github/callback',
};
const WEBAPP = 'https://app.corp.example';

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'user-1'; });
    githubRoutes(typed, { github, webappUrl: WEBAPP });
    await typed.ready();
    return typed;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('webappRedirectUrl', () => {
    it('appends query parameters to WEBAPP_URL', () => {
        expect(webappRedirectUrl('https://app.corp.example', { error: 'invalid_state' })).toBe('https://app.corp.example/?error=invalid_state');
        expect(webappRedirectUrl('https://corp.example/happy', { github: 'connected', user: 'a b' })).toBe('https://corp.example/happy/?github=connected&user=a+b');
    });
});

describe('GitHub routes', () => {
    it('builds the authorize URL from server configuration', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/params' });
        expect(res.statusCode).toBe(200);
        const url = new URL(res.json().url);
        expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(url.searchParams.get('client_id')).toBe('gh-client');
        expect(url.searchParams.get('redirect_uri')).toBe(github.redirectUrl);
        expect(url.searchParams.get('state')).toBe('state-1');
        await app.close();
    });

    it('returns to WEBAPP_URL with an error for an unknown state', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/callback?code=c&state=forged' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('https://app.corp.example/?error=invalid_state');
        await app.close();
    });

    it('returns to WEBAPP_URL after connecting the account', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url === 'https://github.com/login/oauth/access_token') {
                return new Response(JSON.stringify({ access_token: 'gho_test' }), { status: 200 });
            }
            if (url === 'https://api.github.com/user') {
                return new Response(JSON.stringify({ id: 1, login: 'octocat' }), { status: 200 });
            }
            return new Response('unexpected', { status: 500 });
        }));
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/callback?code=c&state=state-1' });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('https://app.corp.example/?github=connected&user=octocat');
        expect(githubConnectMock).toHaveBeenCalledOnce();
        await app.close();
    });

    it('returns GitHub OAuth errors to WEBAPP_URL', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })));
        const app = await buildApp();
        const res = await app.inject({ method: 'GET', url: '/v1/connect/github/callback?code=c&state=state-1' });
        expect(res.headers.location).toBe('https://app.corp.example/?error=bad_verification_code');
        await app.close();
    });
});
