import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { dispatchSessionEventPush } from "@/app/push/pushDispatch";
import { buildSessionEventEphemeral, eventRouter } from "@/app/events/eventRouter";
import { buildSessionEventPush } from "@/app/push/pushCopy";

export function pushRoutes(app: Fastify, opts: { pushEnabled: boolean }) {
    
    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.body;

        try {
            await db.accountPushToken.upsert({
                where: {
                    accountId_token: {
                        accountId: userId,
                        token: token
                    }
                },
                update: {
                    updatedAt: new Date()
                },
                create: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    app.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to delete push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.params;

        try {
            await db.accountPushToken.deleteMany({
                where: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Session-Event Push API
    // CLI/daemon clients call this instead of talking to Expo directly so the
    // server can apply presence-based suppression (active desktop/web/mobile).
    app.post('/v1/sessions/:sessionId/push-event', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                // Older CLIs also send title, body and data. zod strips them: pushes
                // carry only fixed copy built from the kind (see pushCopy.ts).
                kind: z.enum(['done', 'permission', 'question']),
            }),
            response: {
                // `result` reports what actually happened so callers can tell a
                // delivered push from a suppressed one. `success` stays for
                // older clients that only check it.
                200: z.object({
                    success: z.literal(true),
                    result: z.enum(['sent', 'partial', 'suppressed', 'no_tokens', 'failed', 'disabled']),
                    tokens: z.number().optional(),
                    delivered: z.number().optional(),
                    reason: z.string().optional()
                }),
                404: z.object({
                    error: z.literal('Session not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { kind } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Web tabs use this to bump the tab-title unread counter; same fixed copy as the push.
        const push = buildSessionEventPush(sessionId, kind);
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionEventEphemeral(sessionId, kind, push.title, push.body),
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        if (!opts.pushEnabled) {
            return reply.send({ success: true, result: 'disabled' as const });
        }

        // Awaited so the response can report the real outcome. The CLI sends
        // this fire-and-forget, so the extra latency never blocks a turn.
        const outcome = await dispatchSessionEventPush({ userId, sessionId, kind });
        return reply.send({ success: true, ...outcome });
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    createdAt: 'desc'
                }
            });

            return reply.send({
                tokens: tokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime()
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}