import { EventEmitter } from 'node:events';
import { io, Socket } from 'socket.io-client';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import type { EncryptionVariant } from './api';
import { LoggedOutError, socketAuth, type TokenSource } from './tokenStore';

// --- Types ---

export type RefetchedState = {
    metadata: unknown;
    metadataVersion: number;
    agentState: unknown | null;
    agentStateVersion: number;
};

export type CatchUpMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

export type SessionClientOptions = {
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: EncryptionVariant;
    tokens: Pick<TokenSource, 'getAccessToken'>;
    serverUrl: string;
    initialAgentState?: unknown | null;
    /** Called after the socket reconnects, to catch up on session state that may have
     *  changed while disconnected (e.g. a turn completing). Best-effort: errors, or a
     *  version that isn't newer than what's cached, just leave the cached state as-is
     *  until the next socket update arrives. */
    refetchState?: () => Promise<RefetchedState | null>;
    /** Called after the socket reconnects, to catch up on messages missed while
     *  disconnected (e.g. the turn-end event for a turn that finished during the gap).
     *  Returned messages are deduplicated against what's already been seen and replayed
     *  through the same handling as a live message, so a pending `waitForTurnCompletion`
     *  still sees the turn end. Best-effort: errors just leave it to the state catch-up
     *  (`refetchState`) or the next live update. */
    refetchMessages?: () => Promise<CatchUpMessage[]>;
    /** Test hooks: base/cap for the reconnect backoff, and the grace period before a
     *  disconnect that never reconnects fails pending waits. Defaults match production. */
    reconnectBaseDelayMs?: number;
    reconnectMaxDelayMs?: number;
    disconnectGraceMs?: number;
};

type SessionContentEnvelope = {
    role?: unknown;
    content?: unknown;
};

function checkIdleState(
    metadata: unknown | null,
    agentState: unknown | null,
): 'archived' | boolean {
    const meta = metadata as Record<string, unknown> | null;
    if (meta?.lifecycleState === 'archived') {
        return 'archived';
    }

    const state = agentState as Record<string, unknown> | null;
    if (!state) {
        return false;
    }
    const controlledByUser = state.controlledByUser === true;
    const requests = state.requests;
    const hasRequests = requests != null
        && typeof requests === 'object'
        && !Array.isArray(requests)
        && Object.keys(requests as Record<string, unknown>).length > 0;
    return !controlledByUser && !hasRequests;
}

function getTurnEvent(content: unknown): { type: 'turn-start' | 'turn-end'; turnId: string | null } | null {
    if (content == null || typeof content !== 'object' || Array.isArray(content)) {
        return null;
    }

    const envelope = content as SessionContentEnvelope;
    if (envelope.role !== 'session') {
        return null;
    }

    const body = envelope.content as { turn?: unknown; ev?: { t?: unknown } } | null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }

    if (body.ev?.t !== 'turn-start' && body.ev?.t !== 'turn-end') {
        return null;
    }

    return {
        type: body.ev.t,
        turnId: typeof body.turn === 'string' ? body.turn : null,
    };
}

function isReadyEvent(content: unknown): boolean {
    if (content == null || typeof content !== 'object' || Array.isArray(content)) {
        return false;
    }

    const envelope = content as SessionContentEnvelope;
    if (envelope.role !== 'agent') {
        return false;
    }

    const body = envelope.content as { type?: unknown; data?: { type?: unknown } } | null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return false;
    }

    return body.type === 'event' && body.data?.type === 'ready';
}

// --- SessionClient ---

export class SessionClient extends EventEmitter {
    readonly sessionId: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: EncryptionVariant;
    private socket: Socket;
    private metadata: unknown | null = null;
    private metadataVersion = 0;
    private agentState: unknown | null = null;
    private agentStateVersion = 0;
    private lastSeenSeq = 0;

    private readonly refetchState?: () => Promise<RefetchedState | null>;
    private readonly refetchMessages?: () => Promise<CatchUpMessage[]>;
    private readonly reconnectBaseDelayMs: number;
    private readonly reconnectMaxDelayMs: number;
    private readonly disconnectGraceMs: number;
    private reconnectDelayMs: number;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private loggedOut = false;
    private hasDisconnectedOnce = false;

    constructor(opts: SessionClientOptions) {
        super();
        this.sessionId = opts.sessionId;
        this.encryptionKey = opts.encryptionKey;
        this.encryptionVariant = opts.encryptionVariant;
        if (opts.initialAgentState !== undefined) {
            this.agentState = opts.initialAgentState;
        }
        this.refetchState = opts.refetchState;
        this.refetchMessages = opts.refetchMessages;
        this.reconnectBaseDelayMs = opts.reconnectBaseDelayMs ?? 1_000;
        this.reconnectMaxDelayMs = opts.reconnectMaxDelayMs ?? 30_000;
        this.disconnectGraceMs = opts.disconnectGraceMs ?? 60_000;
        this.reconnectDelayMs = this.reconnectBaseDelayMs;

        // Prevent unhandled 'error' event from crashing the process
        this.on('error', () => {});

        this.socket = io(opts.serverUrl, {
            auth: socketAuth(
                opts.tokens,
                { clientType: 'session-scoped', sessionId: opts.sessionId },
                (error) => {
                    // Nothing will refresh a logged-out store: surface it and stop reconnecting.
                    this.loggedOut = true;
                    this.clearReconnectTimer();
                    this.clearDisconnectGrace();
                    this.emit('connect_error', error);
                    this.socket.close();
                },
            ),
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            autoConnect: false,
        });

        this.socket.on('connect', () => {
            this.clearReconnectTimer();
            this.clearDisconnectGrace();
            this.reconnectDelayMs = this.reconnectBaseDelayMs;
            const reconnected = this.hasDisconnectedOnce;
            this.hasDisconnectedOnce = false;
            this.emit('connected');
            if (reconnected) {
                // Catch up on anything that changed while we were disconnected (e.g. a
                // turn completing) instead of only trusting the next push from the server.
                void this.catchUpAfterReconnect();
            }
        });

        this.socket.on('disconnect', (reason: string) => {
            this.emit('disconnected', reason);
            if (this.closed || this.loggedOut) return;
            this.hasDisconnectedOnce = true;
            this.armDisconnectGrace();
            if (reason === 'io server disconnect') {
                // socket.io-client never auto-reconnects after a server-initiated
                // disconnect (e.g. the server cutting an expired-token handshake) —
                // `socketAuth` fetches a fresh token on the next connect attempt.
                this.scheduleReconnect();
            }
        });

        this.socket.on('connect_error', (error: Error) => {
            this.emit('connect_error', error);
            if (this.closed || this.loggedOut) return;
            this.hasDisconnectedOnce = true;
            this.armDisconnectGrace();
            if (!this.socket.active) {
                this.scheduleReconnect();
            }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.socket.on('update', (data: any) => {
            try {
                const body = data?.body;
                if (!body) return;

                if (body.t === 'new-message' && body.message?.content?.t === 'encrypted') {
                    const msg = body.message;
                    const decrypted = decrypt(
                        this.encryptionKey,
                        this.encryptionVariant,
                        decodeBase64(msg.content.c),
                    );
                    if (decrypted === null) return;
                    this.emitMessageIfNew({
                        id: msg.id,
                        seq: msg.seq,
                        content: decrypted,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        updatedAt: msg.updatedAt,
                    });
                } else if (body.t === 'update-session') {
                    if (body.metadata && body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(
                            this.encryptionKey,
                            this.encryptionVariant,
                            decodeBase64(body.metadata.value),
                        );
                        this.metadataVersion = body.metadata.version;
                    }
                    if (body.agentState && body.agentState.version > this.agentStateVersion) {
                        this.agentState = body.agentState.value
                            ? decrypt(
                                  this.encryptionKey,
                                  this.encryptionVariant,
                                  decodeBase64(body.agentState.value),
                              )
                            : null;
                        this.agentStateVersion = body.agentState.version;
                    }
                    this.emit('state-change', {
                        metadata: this.metadata,
                        agentState: this.agentState,
                    });
                }
            } catch (err) {
                this.emit('error', err);
            }
        });

        this.socket.connect();
    }

    sendMessage(text: string, meta?: Record<string, unknown>): void {
        const content = {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
            meta: {
                sentFrom: 'happy-agent',
                ...meta,
            },
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted,
        });
    }

    getMetadata(): unknown | null {
        return this.metadata;
    }

    getAgentState(): unknown | null {
        return this.agentState;
    }

    waitForConnect(timeoutMs = 10_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.socket.connected) {
                resolve();
                return;
            }
            const timeout = setTimeout(() => {
                this.removeListener('connected', onConnect);
                this.removeListener('connect_error', onError);
                reject(new Error('Timeout waiting for socket connection'));
            }, timeoutMs);
            const onConnect = () => {
                clearTimeout(timeout);
                this.removeListener('connect_error', onError);
                resolve();
            };
            const onError = (err: Error) => {
                clearTimeout(timeout);
                this.removeListener('connected', onConnect);
                reject(err);
            };
            this.once('connected', onConnect);
            this.once('connect_error', onError);
        });
    }

    waitForIdle(timeoutMs = 300_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnect-timeout', onDisconnectTimeout);
                this.removeListener('connect_error', onConnectError);
                this.removeListener('closed', onClosed);
            };

            const result = checkIdleState(this.metadata, this.agentState);
            if (result === 'archived') {
                reject(new Error('Session is archived'));
                return;
            }
            if (result === true) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout waiting for agent to become idle'));
            }, timeoutMs);

            const onStateChange = () => {
                const r = checkIdleState(this.metadata, this.agentState);
                if (r === 'archived') {
                    cleanup();
                    reject(new Error('Session is archived'));
                } else if (r === true) {
                    cleanup();
                    resolve();
                }
            };

            // A transient disconnect is not a failure — the socket reconnects on its own
            // (see the constructor) and we catch up on any missed state. Only give up once
            // the socket has been down past the grace period, the store is logged out, or
            // the client is explicitly closed.
            const onDisconnectTimeout = () => {
                cleanup();
                reject(new Error('Socket disconnected while waiting for agent to become idle'));
            };

            const onConnectError = (error: Error) => {
                if (!(error instanceof LoggedOutError)) return;
                cleanup();
                reject(error);
            };

            const onClosed = () => {
                cleanup();
                reject(new Error('Socket closed while waiting for agent to become idle'));
            };

            this.on('state-change', onStateChange);
            this.on('disconnect-timeout', onDisconnectTimeout);
            this.on('connect_error', onConnectError);
            this.on('closed', onClosed);
        });
    }

    waitForTurnCompletion(timeoutMs = 300_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let sawActivity = false;
            let activeTurnId: string | null = null;
            let sawTurnStart = false;
            let sawNonReadyMessage = false;

            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('message', onMessage);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnect-timeout', onDisconnectTimeout);
                this.removeListener('connect_error', onConnectError);
                this.removeListener('closed', onClosed);
            };

            const finish = (error?: Error) => {
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const timeout = setTimeout(() => {
                finish(new Error('Timeout waiting for agent turn completion'));
            }, timeoutMs);

            const onMessage = (message: { content: unknown }) => {
                sawActivity = true;

                const turnEvent = getTurnEvent(message.content);
                if (turnEvent) {
                    if (turnEvent.type === 'turn-start') {
                        sawTurnStart = true;
                        sawNonReadyMessage = true;
                        activeTurnId = turnEvent.turnId;
                        return;
                    }

                    if (activeTurnId == null || turnEvent.turnId == null || turnEvent.turnId === activeTurnId) {
                        finish();
                    }
                    return;
                }

                if (isReadyEvent(message.content)) {
                    if (sawTurnStart || sawNonReadyMessage) {
                        finish();
                    }
                    return;
                }

                sawNonReadyMessage = true;
            };

            const onStateChange = (payload?: { viaReconnect?: boolean }) => {
                if (!sawActivity) {
                    return;
                }
                // Normally, once a turn has started, only an explicit turn-end message
                // (handled in onMessage above) counts as completion — idle state can lag
                // or race. But a state-change from the post-reconnect catch-up is a fresh
                // REST snapshot taken *after* the gap, not a live push that might race the
                // turn-end message; if it says idle, trust it even mid-turn.
                if (sawTurnStart && !payload?.viaReconnect) {
                    return;
                }

                const result = checkIdleState(this.metadata, this.agentState);
                if (result === 'archived') {
                    finish(new Error('Session is archived'));
                } else if (result === true) {
                    finish();
                }
            };

            // Same rationale as waitForIdle: a transient disconnect recovers on its own,
            // so only fail once the socket is down past the grace period, the store is
            // logged out, or the client is explicitly closed.
            const onDisconnectTimeout = () => {
                finish(new Error('Socket disconnected while waiting for agent turn completion'));
            };

            const onConnectError = (error: Error) => {
                if (!(error instanceof LoggedOutError)) return;
                finish(error);
            };

            const onClosed = () => {
                finish(new Error('Socket closed while waiting for agent turn completion'));
            };

            this.on('message', onMessage);
            this.on('state-change', onStateChange);
            this.on('disconnect-timeout', onDisconnectTimeout);
            this.on('connect_error', onConnectError);
            this.on('closed', onClosed);
        });
    }

    sendStop(): void {
        this.socket.emit('session-end', {
            sid: this.sessionId,
            time: Date.now(),
        });
    }

    close(): void {
        this.closed = true;
        this.clearReconnectTimer();
        this.clearDisconnectGrace();
        this.emit('closed');
        this.socket.close();
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer) return;
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxDelayMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed && !this.socket.connected) {
                this.socket.connect();
            }
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private armDisconnectGrace(): void {
        if (this.disconnectGraceTimer) return;
        this.disconnectGraceTimer = setTimeout(() => {
            this.disconnectGraceTimer = null;
            this.emit('disconnect-timeout');
        }, this.disconnectGraceMs);
    }

    private clearDisconnectGrace(): void {
        if (this.disconnectGraceTimer) {
            clearTimeout(this.disconnectGraceTimer);
            this.disconnectGraceTimer = null;
        }
    }

    /** Shared by the live 'update' handler and the post-reconnect message catch-up, so a
     *  replayed message runs through the exact same `waitForTurnCompletion` detection as
     *  a live one. Deduplicates by `seq` — the server assigns it as a strictly increasing
     *  per-session counter, so the catch-up fetch can safely overlap with messages the
     *  live socket already delivered. */
    private emitMessageIfNew(message: CatchUpMessage): void {
        if (message.seq <= this.lastSeenSeq) return;
        this.lastSeenSeq = message.seq;
        this.emit('message', message);
    }

    private async catchUpAfterReconnect(): Promise<void> {
        if (this.closed) return;

        // Replay any message missed while disconnected (e.g. the turn-end for a turn
        // that finished during the gap) through the normal message handling, so a
        // pending waitForTurnCompletion can still detect it precisely.
        if (this.refetchMessages) {
            let messages: CatchUpMessage[] | null;
            try {
                messages = await this.refetchMessages();
            } catch {
                messages = null;
            }
            if (this.closed) return;
            if (messages) {
                const missed = messages
                    .filter((m) => m.seq > this.lastSeenSeq)
                    .sort((a, b) => a.seq - b.seq);
                for (const message of missed) {
                    this.emitMessageIfNew(message);
                }
            }
        }

        if (this.closed) return;
        if (!this.refetchState) return;

        let fresh: RefetchedState | null;
        try {
            fresh = await this.refetchState();
        } catch {
            // Best-effort: keep serving cached state until the next socket update.
            return;
        }
        if (this.closed) return;
        if (!fresh) return;

        let changed = false;
        if (fresh.metadataVersion > this.metadataVersion) {
            this.metadata = fresh.metadata;
            this.metadataVersion = fresh.metadataVersion;
            changed = true;
        }
        if (fresh.agentStateVersion > this.agentStateVersion) {
            this.agentState = fresh.agentState;
            this.agentStateVersion = fresh.agentStateVersion;
            changed = true;
        }
        if (changed) {
            // `viaReconnect` lets waitForTurnCompletion trust a re-fetched idle state as
            // completion even after it has seen a turn-start — unlike a live update, there's
            // no better signal left once we're relying on a REST snapshot taken after the gap.
            this.emit('state-change', {
                metadata: this.metadata,
                agentState: this.agentState,
                viaReconnect: true,
            });
        }
    }
}
