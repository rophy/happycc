import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema } from "@slopus/happy-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import type { VoiceConfig } from "@/app/features/featuresConfig";

// ElevenLabs returns at most 100 conversations per query, so usage past that cannot be counted.
const VOICE_MAX_CONVERSATIONS = 100;
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";

function deriveElevenUserId(happyUserId: string): string {
    const hmac = crypto.createHmac("sha256", process.env.HANDY_MASTER_SECRET!);
    hmac.update(happyUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * A user's voice usage over the last 30 days, queried from ElevenLabs by
 * user_id (set via participant_name when the token is minted). A failed query
 * counts as zero usage.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<{ usedSeconds: number; conversationCount: number }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    const res = await fetch(
        `${ELEVEN_LABS_API}/conversations?user_id=${elevenUserId}&created_after=${thirtyDaysAgo}&page_size=${VOICE_MAX_CONVERSATIONS}`,
        { headers: { "xi-api-key": elevenLabsApiKey } }
    );
    if (!res.ok) {
        log({ module: 'voice' }, `ElevenLabs conversations query failed: ${res.status}`);
        return { usedSeconds: 0, conversationCount: 0 };
    }
    const data = (await res.json()) as { conversations?: Array<{ call_duration_secs: number }> };
    const conversations = data.conversations || [];
    let usedSeconds = 0;
    for (const c of conversations) {
        usedSeconds += c.call_duration_secs ?? 0;
    }
    return { usedSeconds, conversationCount: conversations.length };
}

/**
 * Registered only when ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are set.
 * Voice is available to every user; VOICE_MONTHLY_LIMIT_MINUTES optionally
 * caps each user's usage over the rolling 30-day window.
 */
export function voiceRoutes(app: Fastify, voice: VoiceConfig) {
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            // No body: the agent id is server configuration. Older apps still send
            // { agentId }; it is ignored.
            response: {
                200: VoiceConversationResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const elevenUserId = deriveElevenUserId(userId);
        const limitSeconds = voice.monthlyLimitSeconds;
        let usedSeconds = 0;

        log({ module: 'voice' }, `Voice token request from user ${userId}`);

        if (limitSeconds !== null) {
            const usage = await getVoiceUsage(voice.apiKey, elevenUserId);
            usedSeconds = usage.usedSeconds;
            log({ module: 'voice' }, `User ${userId}: ${usedSeconds}s of ${limitSeconds}s used, ${usage.conversationCount} conversations`);
            if (usage.conversationCount >= VOICE_MAX_CONVERSATIONS) {
                return reply.send({
                    allowed: false as const,
                    reason: 'voice_conversation_limit_reached' as const,
                    usedSeconds,
                    limitSeconds,
                    agentId: voice.agentId,
                });
            }
            if (usedSeconds >= limitSeconds) {
                return reply.send({
                    allowed: false as const,
                    reason: 'voice_monthly_limit_reached' as const,
                    usedSeconds,
                    limitSeconds,
                    agentId: voice.agentId,
                });
            }
        }

        try {
            const tokenRes = await fetch(
                `${ELEVEN_LABS_API}/conversation/token?agent_id=${encodeURIComponent(voice.agentId)}&participant_name=${elevenUserId}`,
                { headers: { 'xi-api-key': voice.apiKey } }
            );
            if (!tokenRes.ok) {
                log({ module: 'voice' }, `Failed to get conversation token for user ${userId}: ${tokenRes.status}`);
                return reply.code(500).send({ error: 'Failed to get voice credentials' });
            }
            const { token: conversationToken } = (await tokenRes.json()) as { token: string };

            // The LiveKit room name inside the JWT carries the conversation id.
            const jwtPayload = JSON.parse(Buffer.from(conversationToken.split('.')[1], 'base64').toString());
            const conversationId = (jwtPayload.video?.room || '').match(/(conv_[a-zA-Z0-9]+)/)?.[0];
            if (!conversationId) {
                log({ module: 'voice' }, `No conversation_id in JWT for user ${userId}`);
                return reply.code(500).send({ error: 'Failed to get conversation ID' });
            }

            log({ module: 'voice' }, `Voice token issued for user ${userId}, conv=${conversationId}`);
            return reply.send({
                allowed: true as const,
                conversationToken,
                conversationId,
                agentId: voice.agentId,
                elevenUserId,
                usedSeconds,
                limitSeconds,
            });
        } catch (error) {
            log({ module: 'voice' }, `ElevenLabs request error for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(500).send({ error: 'Failed to get voice credentials' });
        }
    });

    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const elevenUserId = deriveElevenUserId(userId);
        try {
            const { usedSeconds, conversationCount } = await getVoiceUsage(voice.apiKey, elevenUserId);
            return reply.send({
                usedSeconds,
                limitSeconds: voice.monthlyLimitSeconds,
                conversationCount,
                conversationLimit: voice.monthlyLimitSeconds === null ? null : VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            });
        } catch (error) {
            log({ module: 'voice' }, `Failed to get voice usage for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });
}
