import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyToken = vi.fn();
const isDeviceActive = vi.fn();
const sessionBelongsToUser = vi.fn();
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
vi.mock('@/app/auth/auth', () => ({ auth: { verifyToken: (...a: unknown[]) => verifyToken(...a) } }));
vi.mock('@/app/auth/oidc/devices', () => ({ isDeviceActive: (...a: unknown[]) => isDeviceActive(...a) }));
vi.mock('@/app/auth/oidc/oidcRuntime', () => ({ getOidcRuntime: () => ({ config: { maxSessionAgeSec: 3600 } }) }));
vi.mock('./sessionOwnership', () => ({ sessionBelongsToUser: (...a: unknown[]) => sessionBelongsToUser(...a) }));

import { authenticateSocket } from './socketAuth';

function sessionSocket() {
    return {
        handshake: { auth: { token: 't', clientType: 'session-scoped', sessionId: 's1' }, headers: {} },
        data: {} as Record<string, unknown>,
    } as any;
}

describe('authenticateSocket', () => {
    beforeEach(() => {
        verifyToken.mockReset().mockResolvedValue({ userId: 'u1', deviceId: 'd1', expiresAt: Date.now() + 60_000 });
        isDeviceActive.mockReset().mockResolvedValue(true);
        sessionBelongsToUser.mockReset();
    });

    it('rejects a session-scoped socket when the ownership check fails, without throwing', async () => {
        sessionBelongsToUser.mockRejectedValue(new Error('db down'));
        const next = vi.fn();
        const socket = sessionSocket();

        await expect(authenticateSocket(socket, next)).resolves.toBeUndefined();

        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(socket.data.userId).toBeUndefined();
    });

    it('rejects a session of another account', async () => {
        sessionBelongsToUser.mockResolvedValue(false);
        const next = vi.fn();
        await authenticateSocket(sessionSocket(), next);
        expect(next).toHaveBeenCalledWith(new Error('Session not found'));
    });

    it('accepts the account\'s own session', async () => {
        sessionBelongsToUser.mockResolvedValue(true);
        const next = vi.fn();
        const socket = sessionSocket();
        await authenticateSocket(socket, next);
        expect(next).toHaveBeenCalledWith();
        expect(socket.data).toMatchObject({ userId: 'u1', deviceId: 'd1', sessionId: 's1', clientType: 'session-scoped' });
    });

    it('rejects when the device check fails, without throwing', async () => {
        isDeviceActive.mockRejectedValue(new Error('db down'));
        const next = vi.fn();
        await expect(authenticateSocket(sessionSocket(), next)).resolves.toBeUndefined();
        expect(next).toHaveBeenCalledWith(new Error('Invalid authentication token'));
        expect(sessionBelongsToUser).not.toHaveBeenCalled();
    });
});
