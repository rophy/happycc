import { Fastify } from "../types";
import { debug } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { authorizeDevice, forbiddenBody } from "@/app/auth/authz/authz";

export function enableAuthentication(app: Fastify) {
    // Token and device verification only; sets request.userId / request.deviceId.
    const verifyRequest = async function (request: any, reply: any) {
        const authHeader = request.headers.authorization;
        const route = request.routeOptions?.url || '<unmatched>';
        debug({ module: 'auth' }, `auth:check route=${route} hasHeader=${!!authHeader}`);
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            debug({ module: 'auth' }, 'auth:failed reason=missing-or-invalid-header');
            reply.code(401).send({ error: 'Missing authorization header' });
            return false;
        }

        const token = authHeader.substring(7);
        const verified = await auth.verifyToken(token);
        if (!verified) {
            debug({ module: 'auth' }, 'auth:failed reason=invalid-token');
            reply.code(401).send({ error: 'Invalid token' });
            return false;
        }

        debug({ module: 'auth' }, `auth:success userId=${verified.userId}`);
        request.userId = verified.userId;
        request.deviceId = verified.deviceId;
        return true;
    };

    // Token check only: for routes a denied device must still reach (sign out).
    app.decorate('authenticateToken', async function (request: any, reply: any) {
        try {
            await verifyRequest(request, reply);
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });

    // Token check plus the authorization decision.
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            if (!(await verifyRequest(request, reply))) return;
            const decision = await authorizeDevice(request.deviceId);
            if (!decision.allowed) {
                debug({ module: 'auth' }, `auth:forbidden userId=${request.userId}`);
                return reply.code(403).send(forbiddenBody(decision));
            }
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
