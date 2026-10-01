import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
import { voiceRoutes } from "./voiceRoutes";
import type { VoiceConfig } from "@/app/features/featuresConfig";

const base: VoiceConfig = { apiKey: 'xi-key', agentId: 'agent_corp', monthlyLimitSeconds: null };

function conversationToken(conversationId: string): string {
    const payload = Buffer.from(JSON.stringify({ video: { room: `room_${conversationId}` } })).toString('base64url');
    return `header.${payload}.signature`;
}

/** Fakes ElevenLabs; returns the list of requested URLs. */
function stubElevenLabs(durations: number[] = []): string[] {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('https://api.elevenlabs.io/v1/convai/conversations?')) {
            return new Response(JSON.stringify({ conversations: durations.map((s) => ({ call_duration_secs: s })) }), { status: 200 });
        }
        if (url.startsWith('https://api.elevenlabs.io/v1/convai/conversation/token?')) {
            return new Response(JSON.stringify({ token: conversationToken('conv_abc123') }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
    }));
    return calls;
}

async function buildApp(voice: VoiceConfig): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = 'user-1'; });
    voiceRoutes(typed, voice);
    await typed.ready();
    return typed;
}

const savedMasterSecret = process.env.HANDY_MASTER_SECRET;
beforeAll(() => { process.env.HANDY_MASTER_SECRET = 'x'.repeat(32); });
afterAll(() => {
    if (savedMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = savedMasterSecret;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('POST /v1/voice/conversations', () => {
    it('uses the server agent id, ignores the client one, and skips accounting without a cap', async () => {
        const calls = stubElevenLabs();
        const app = await buildApp(base);
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations', payload: { agentId: 'agent_from_client' } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            allowed: true,
            agentId: 'agent_corp',
            conversationId: 'conv_abc123',
            usedSeconds: 0,
            limitSeconds: null,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('agent_id=agent_corp');
        expect(calls.join(' ')).not.toContain('agent_from_client');
        await app.close();
    });

    it('accepts a request without a body', async () => {
        stubElevenLabs();
        const app = await buildApp(base);
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.statusCode).toBe(200);
        expect(res.json().allowed).toBe(true);
        await app.close();
    });

    it('grants under the cap and reports it', async () => {
        stubElevenLabs([120]);
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.json()).toMatchObject({ allowed: true, usedSeconds: 120, limitSeconds: 600 });
        await app.close();
    });

    it('denies once the monthly cap is used up, without minting a token', async () => {
        const calls = stubElevenLabs([400, 200]);
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.json()).toEqual({
            allowed: false,
            reason: 'voice_monthly_limit_reached',
            usedSeconds: 600,
            limitSeconds: 600,
            agentId: 'agent_corp',
        });
        expect(calls.some((url) => url.includes('/conversation/token'))).toBe(false);
        await app.close();
    });

    it('denies when usage can no longer be counted (100 conversations)', async () => {
        stubElevenLabs(Array(100).fill(1));
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'POST', url: '/v1/voice/conversations' });
        expect(res.json()).toMatchObject({ allowed: false, reason: 'voice_conversation_limit_reached' });
        await app.close();
    });
});

describe('GET /v1/voice/usage', () => {
    it('reports usage with no limits when no cap is set', async () => {
        stubElevenLabs([30, 30]);
        const app = await buildApp(base);
        const res = await app.inject({ method: 'GET', url: '/v1/voice/usage' });
        expect(res.json()).toMatchObject({ usedSeconds: 60, limitSeconds: null, conversationCount: 2, conversationLimit: null });
        await app.close();
    });

    it('reports the cap when set', async () => {
        stubElevenLabs([30]);
        const app = await buildApp({ ...base, monthlyLimitSeconds: 600 });
        const res = await app.inject({ method: 'GET', url: '/v1/voice/usage' });
        expect(res.json()).toMatchObject({ usedSeconds: 30, limitSeconds: 600, conversationLimit: 100 });
        await app.close();
    });
});
