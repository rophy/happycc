import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { deviceRoom, setSocketServer } from "@/app/auth/oidc/deviceSockets";
import { isDeviceActive } from "@/app/auth/oidc/devices";
import { getOidcRuntime } from "@/app/auth/oidc/oidcRuntime";
import { getMetricsLabelsFromSocket, redisStreamLagMsGauge, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { sessionBelongsToUser } from "./socket/sessionOwnership";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { socketServerOptions } from "./socketConfig";

/** Sockets outlive their access token by this much, then are disconnected; clients reconnect with a fresh token. */
const TOKEN_EXPIRY_GRACE_MS = 60_000;
/** setTimeout's maximum delay. */
const MAX_TIMER_MS = 2_147_483_647;

export function startSocket(app: Fastify) {
    const io = new Server(app.server, socketServerOptions);
    setSocketServer(io);

    // Multi-process support: attach Redis streams adapter when REDIS_URL is set
    if (process.env.REDIS_URL) {
        const streamClient = new Redis(process.env.REDIS_URL);
        io.adapter(createAdapter(streamClient, { maxLen: 200000, readCount: 2000 }));
        log({ module: 'websocket' }, 'Redis streams adapter enabled for multi-process support');

        // Track stream reader lag: wrap onRawMessage to capture last-read offset,
        // then periodically compare against stream HEAD.
        let lastReadOffset = "0-0";
        const adapter = io.of("/").adapter as any;
        const origOnRawMessage = adapter.onRawMessage.bind(adapter);
        adapter.onRawMessage = (msg: any, offset: string) => {
            lastReadOffset = offset;
            return origOnRawMessage(msg, offset);
        };
        setInterval(async () => {
            try {
                const info = await streamClient.xinfo("STREAM", "socket.io") as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
            } catch { /* stream may not exist yet */ }
        }, 5000);
    }

    // Initialize event router with Socket.IO server instance
    eventRouter.init(io);

    // Auth runs in middleware so it completes BEFORE the client's `connect`
    // event fires. Without this, the async verifyToken in the connection
    // callback creates a window where client events (rpc-register, rpc-call)
    // arrive before handlers are attached — and get silently dropped.
    io.use(async (socket, next) => {
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

        if (clientType === 'session-scoped' && !(await sessionBelongsToUser(sessionId!, verified.userId))) {
            log({ module: 'websocket' }, `Session-scoped client for unknown or foreign session`);
            next(new Error('Session not found'));
            return;
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
    });

    io.on("connection", (socket) => {
        socket.join(deviceRoom(socket.data.deviceId as string));

        // Bound the socket by its access token's lifetime.
        const expiryDelay = Math.min(
            Math.max(0, (socket.data.tokenExpiresAt as number) + TOKEN_EXPIRY_GRACE_MS - Date.now()),
            MAX_TIMER_MS,
        );
        const expiryTimer = setTimeout(() => {
            log({ module: 'websocket' }, `Access token expired, disconnecting socket ${socket.id}`);
            socket.disconnect(true);
        }, expiryDelay);

        const userId = socket.data.userId as string;
        const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.data.sessionId as string | undefined;
        const machineId = socket.data.machineId as string | undefined;
        const labels = getMetricsLabelsFromSocket(socket);

        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, client: ${labels.client}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        const happyClient = socket.data.happyClient as string | undefined;
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId,
                happyClient
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId,
                happyClient
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId,
                happyClient
            };
        }
        eventRouter.addConnection(userId, connection);
        websocketConnectionsGauge.inc({ type: connection.connectionType, ...labels });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(machineId!, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Track app focus state for push notification routing.
        // State lives on socket.data — no external storage needed.
        // Read initial state from handshake to close the race window between
        // connect and the first async app-state event.
        const initialAppState = socket.handshake.auth.appState as string | undefined;
        if (initialAppState) {
            socket.data.appState = initialAppState === 'active' ? 'active' : 'background';
        }

        socket.on('app-state', (data: { state: string }) => {
            socket.data.appState = data?.state === 'active' ? 'active' : 'background';
        });

        socket.on('disconnect', () => {
            clearTimeout(expiryTimer);
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });

            log({ module: 'websocket' }, `User disconnected: ${userId}`);

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        });

        // Handlers
        rpcHandler(userId, socket, io);
        usageHandler(userId, socket);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket);

        // Ready
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    onShutdown('api', async () => {
        await io.close();
    });
}