import type { Socket } from "socket.io";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { isDeviceActive } from "@/app/auth/oidc/devices";
import { getOidcRuntime } from "@/app/auth/oidc/oidcRuntime";
import { sessionBelongsToUser } from "./sessionOwnership";

/**
 * Socket.IO auth middleware: verifies the token, the device and, for a
 * session-scoped client, that the session belongs to the account. Every
 * failure rejects the connection through `next`; it never throws.
 */
export async function authenticateSocket(socket: Socket, next: (err?: Error) => void): Promise<void> {
    const token = socket.handshake.auth.token as string;
    const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
    const sessionId = socket.handshake.auth.sessionId as string | undefined;
    const machineId = socket.handshake.auth.machineId as string | undefined;

    if (!token) {
        log({ module: 'websocket' }, `No token provided`);
        next(new Error('Missing authentication token'));
        return;
    }

    if (clientType === 'session-scoped' && !sessionId) {
        log({ module: 'websocket' }, `Session-scoped client missing sessionId`);
        next(new Error('Session ID required for session-scoped clients'));
        return;
    }

    if (clientType === 'machine-scoped' && !machineId) {
        log({ module: 'websocket' }, `Machine-scoped client missing machineId`);
        next(new Error('Machine ID required for machine-scoped clients'));
        return;
    }

    const verified = await auth.verifyToken(token);
    if (!verified) {
        log({ module: 'websocket' }, `Invalid token provided`);
        next(new Error('Invalid authentication token'));
        return;
    }

    // The access token alone does not reflect revocation, account disabling or
    // max session age; check the device before accepting the socket.
    let active: boolean;
    try {
        active = await isDeviceActive(verified.deviceId, verified.userId, {
            maxSessionAgeSec: getOidcRuntime().config.maxSessionAgeSec,
        });
    } catch (error) {
        log({ module: 'websocket', level: 'error' }, `Device check failed: ${error}`);
        active = false;
    }
    if (!active) {
        log({ module: 'websocket' }, `Inactive device for token`);
        next(new Error('Invalid authentication token'));
        return;
    }

    if (clientType === 'session-scoped') {
        // A failed check rejects the socket; thrown here it would be an
        // unhandled rejection, which exits the server.
        let owned: boolean;
        try {
            owned = await sessionBelongsToUser(sessionId!, verified.userId);
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Session ownership check failed: ${error}`);
            next(new Error('Session check failed'));
            return;
        }
        if (!owned) {
            log({ module: 'websocket' }, `Session-scoped client for unknown or foreign session`);
            next(new Error('Session not found'));
            return;
        }
    }

    socket.data.userId = verified.userId;
    socket.data.deviceId = verified.deviceId;
    socket.data.tokenExpiresAt = verified.expiresAt;
    socket.data.clientType = clientType;
    socket.data.sessionId = sessionId;
    socket.data.machineId = machineId;
    socket.data.happyClient = socket.handshake.auth.happyClient as string
        || socket.handshake.headers['x-happy-client'] as string
        || undefined;
    next();
}
