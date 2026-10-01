import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fastify } from "../types";
import { versionRoutes } from "./versionRoutes";

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    versionRoutes(typed);
    await typed.ready();
    return typed;
}

const saved = {
    APP_STORE_URL: process.env.APP_STORE_URL,
    PLAY_STORE_URL: process.env.PLAY_STORE_URL,
};

afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

beforeEach(() => {
    delete process.env.APP_STORE_URL;
    delete process.env.PLAY_STORE_URL;
});

describe('versionRoutes', () => {
    it('returns no update URL for an outdated client when the store settings are unset', async () => {
        const app = await buildApp();
        const ios = await app.inject({ method: 'POST', url: '/v1/version', payload: { platform: 'ios', version: '0.0.1', app_id: 'a' } });
        expect(ios.json()).toEqual({ updateUrl: null });

        const android = await app.inject({ method: 'POST', url: '/v1/version', payload: { platform: 'android', version: '0.0.1', app_id: 'a' } });
        expect(android.json()).toEqual({ updateUrl: null });
        await app.close();
    });

    it('returns the operator-configured store URL for an outdated client', async () => {
        process.env.APP_STORE_URL = 'https://apps.apple.com/us/app/acme-happy/id123';
        process.env.PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.acme.happy';
        const app = await buildApp();

        const ios = await app.inject({ method: 'POST', url: '/v1/version', payload: { platform: 'ios', version: '0.0.1', app_id: 'a' } });
        expect(ios.json()).toEqual({ updateUrl: 'https://apps.apple.com/us/app/acme-happy/id123' });

        const android = await app.inject({ method: 'POST', url: '/v1/version', payload: { platform: 'android', version: '0.0.1', app_id: 'a' } });
        expect(android.json()).toEqual({ updateUrl: 'https://play.google.com/store/apps/details?id=com.acme.happy' });
        await app.close();
    });

    it('returns no update URL for an up-to-date client even when the store settings are set', async () => {
        process.env.APP_STORE_URL = 'https://apps.apple.com/us/app/acme-happy/id123';
        const app = await buildApp();
        const ios = await app.inject({ method: 'POST', url: '/v1/version', payload: { platform: 'ios', version: '999.0.0', app_id: 'a' } });
        expect(ios.json()).toEqual({ updateUrl: null });
        await app.close();
    });

    it('returns no update URL for an unknown platform', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'POST', url: '/v1/version', payload: { platform: 'windows', version: '0.0.1', app_id: 'a' } });
        expect(res.json()).toEqual({ updateUrl: null });
        await app.close();
    });
});
