import type { Socket } from "socket.io";
import { log } from "@/utils/log";
import { authorizeDevice, forbiddenBody } from "@/app/auth/authz/authz";
import { UNAVAILABLE_REASON } from "@/app/auth/authz/authzWebhook";

/**
 * Re-checks authorization of an open socket. A denial (or a failed check, which must never
 * leave the socket open) tells the client why, then disconnects it.
 */
export async function recheckSocketAuthorization(socket: Socket): Promise<void> {
    try {
        const decision = await authorizeDevice(socket.data.deviceId as string);
        if (!decision.allowed) {
            socket.emit('forbidden', forbiddenBody(decision));
            socket.disconnect(true);
        }
    } catch (error) {
        log({ module: 'websocket', level: 'error' }, `Authorization re-check failed: ${error}`);
        socket.emit('forbidden', forbiddenBody({ allowed: false, reason: UNAVAILABLE_REASON }));
        socket.disconnect(true);
    }
}
