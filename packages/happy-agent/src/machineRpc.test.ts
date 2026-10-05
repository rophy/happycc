import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const sockets: (EventEmitter & { connected: boolean; close: () => void; connect: () => void })[] = [];
vi.mock('socket.io-client', () => ({
    io: () => {
        const socket = Object.assign(new EventEmitter(), { connected: false, close: vi.fn(), connect: vi.fn() });
        sockets.push(socket);
        return socket;
    },
}));

import { connectRpcSocket } from './machineRpc';
import { ForbiddenError } from './forbidden';

describe('connectRpcSocket', () => {
    it('rejects with the not-authorized message when the server denies the device', async () => {
        const promise = connectRpcSocket(
            { serverUrl: 'http://x' } as never,
            { getAccessToken: async () => 't' } as never,
        );
        await new Promise((r) => setTimeout(r, 0));
        sockets[0].emit('connect_error', Object.assign(new Error('forbidden'), { data: { error: 'forbidden', reason: 'Ask IT' } }));
        const error = await promise.catch((e) => e);
        expect(error).toBeInstanceOf(ForbiddenError);
        expect(error.message).toBe('Not authorized: Ask IT');
    });
});
