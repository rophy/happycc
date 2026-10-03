import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

vi.mock("@/app/auth/auth", () => ({
    auth: { createGithubToken: vi.fn(async () => 'state-1'), verifyGithubToken: vi.fn(async () => null) },
}));
vi.mock("@/app/github/githubConnect", () => ({ githubConnect: vi.fn() }));
vi.mock("@/app/github/githubDisconnect", () => ({ githubDisconnect: vi.fn() }));

import { integrationRoutes } from "./integrationRoutes";
import { loadFeaturesConfig } from "@/app/features/featuresConfig";

const AUTH = { authorization: 'Bearer t' };

async function buildApp(env: Record<string, string>): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        if (!request.headers.authorization) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        request.userId = 'user-1';
    });
    integrationRoutes(typed, loadFeaturesConfig(env), { webappUrl: 'https://app.corp.example' });
    await typed.ready();
    return typed;
}

const savedMasterSecret = process.env.HANDY_MASTER_SECRET;

beforeEach(() => {
    process.env.HANDY_MASTER_SECRET = 'x'.repeat(32);
    // No test may reach GitHub.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});

afterEach(() => {
    vi.unstubAllGlobals();
    if (savedMasterSecret === undefined) {
        delete process.env.HANDY_MASTER_SECRET;
    } else {
        process.env.HANDY_MASTER_SECRET = savedMasterSecret;
    }
});

describe('integrationRoutes', () => {
    it('reports integrations off and registers no GitHub routes by default', async () => {
        const app = await buildApp({});
        const features = await app.inject({ method: 'GET', url: '/v1/features', headers: AUTH });
        expect(features.statusCode).toBe(200);
        expect(features.json()).toEqual({ githubConnect: false, push: true });

        const unregistered = [
            ['POST', '/v1/voice/conversations'],
            ['GET', '/v1/voice/usage'],
            ['GET', '/v1/connect/github/params'],
            ['GET', '/v1/connect/github/callback?code=c&state=s'],
            ['POST', '/v1/connect/github/webhook'],
            ['DELETE', '/v1/connect/github'],
        ] as const;
        for (const [method, url] of unregistered) {
            const res = await app.inject({ method, url, headers: AUTH });
            expect(res.statusCode, `${method} ${url}`).toBe(404);
        }
        await app.close();
    });

    it('requires authentication for /v1/features', async () => {
        const app = await buildApp({});
        const res = await app.inject({ method: 'GET', url: '/v1/features' });
        expect(res.statusCode).toBe(401);
        await app.close();
    });

    it('registers GitHub routes when configured, never voice routes', async () => {
        const app = await buildApp({
            VOICE_MONTHLY_LIMIT_MINUTES: '60',
            GITHUB_CLIENT_ID: 'gh-client',
            GITHUB_CLIENT_SECRET: 'gh-secret',
            GITHUB_REDIRECT_URL: 'https://happy.corp.example/v1/connect/github/callback',
            PUSH_ENABLED: 'false',
        });
        const features = await app.inject({ method: 'GET', url: '/v1/features', headers: AUTH });
        expect(features.json()).toEqual({ githubConnect: true, push: false });

        const usage = await app.inject({ method: 'GET', url: '/v1/voice/usage', headers: AUTH });
        expect(usage.statusCode).toBe(404);
        const params = await app.inject({ method: 'GET', url: '/v1/connect/github/params', headers: AUTH });
        expect(params.statusCode).toBe(200);
        await app.close();
    });
});
