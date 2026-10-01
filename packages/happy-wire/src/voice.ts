import * as z from 'zod';

export const VoiceConversationGrantedSchema = z.object({
    allowed: z.literal(true),
    conversationToken: z.string(),
    conversationId: z.string(),
    agentId: z.string(),
    elevenUserId: z.string(),
    usedSeconds: z.number(),
    /** null when the server sets no monthly cap */
    limitSeconds: z.number().nullable(),
});

export const VoiceConversationDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_monthly_limit_reached', 'voice_conversation_limit_reached']),
    usedSeconds: z.number(),
    limitSeconds: z.number(),
    agentId: z.string(),
});

export const VoiceConversationResponseSchema = z.discriminatedUnion('allowed', [
    VoiceConversationGrantedSchema,
    VoiceConversationDeniedSchema,
]);

export type VoiceConversationResponse = z.infer<typeof VoiceConversationResponseSchema>;

export const VoiceUsageResponseSchema = z.object({
    usedSeconds: z.number(),
    /** null when the server sets no monthly cap */
    limitSeconds: z.number().nullable(),
    conversationCount: z.number(),
    /** null when the server sets no monthly cap (nothing is enforced) */
    conversationLimit: z.number().nullable(),
    elevenUserId: z.string(),
});

export type VoiceUsageResponse = z.infer<typeof VoiceUsageResponseSchema>;
