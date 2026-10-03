import { describe, expect, it, vi } from 'vitest';
import { rpcHandler } from './rpcHandler';

function makeSocket(data: Record<string, unknown>) {
    const handlers = new Map<string, (payload: any) => void>();
    const socket = {
        data,
        on: vi.fn((event: string, fn: (payload: any) => void) => { handlers.set(event, fn); }),
        join: vi.fn(),
        emit: vi.fn(),
    };
    rpcHandler('u1', socket as any, {} as any);
    return { socket, handlers };
}

describe('rpc-register', () => {
    it('refuses and does not join for a non-session socket', () => {
        const { socket, handlers } = makeSocket({ clientType: 'machine-scoped' });
        handlers.get('rpc-register')!({ method: 'm1:spawn-happy-session' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', { type: 'register', error: 'RPC method not allowed' });
    });
    it('refuses another session\'s method', () => {
        const { socket, handlers } = makeSocket({ clientType: 'session-scoped', sessionId: 's1' });
        handlers.get('rpc-register')!({ method: 's2:bash' });
        expect(socket.join).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', { type: 'register', error: 'RPC method not allowed' });
    });
    it('joins and acknowledges the session\'s own method', () => {
        const { socket, handlers } = makeSocket({ clientType: 'session-scoped', sessionId: 's1' });
        handlers.get('rpc-register')!({ method: 's1:bash' });
        expect(socket.join).toHaveBeenCalledWith('rpc:u1:s1:bash');
        expect(socket.emit).toHaveBeenCalledWith('rpc-registered', { method: 's1:bash' });
    });
});
