import { z } from 'zod';
import { type Fastify } from '../types';
import type { AuthRouteDeps } from './oidcRoutes';
import { refreshDevice, revokeDevice } from '@/app/auth/oidc/devices';

export function tokenRoutes(app: Fastify, deps: AuthRouteDeps) {
    app.post('/v1/auth/refresh', {
        schema: { body: z.object({ refreshToken: z.string().max(256) }) },
    }, async (request, reply) => {
        const result = await refreshDevice(request.body.refreshToken, {
            maxSessionAgeSec: deps.config.maxSessionAgeSec,
            checkIdp: deps.checkIdp,
        });
        if (!result.ok) {
            return reply.code(401).send({ error: 'invalid_grant', reason: result.reason });
        }
        return reply.send(result.tokens);
    });

    app.post('/v1/auth/logout', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        await revokeDevice(request.deviceId);
        return reply.send({ success: true });
    });
}
