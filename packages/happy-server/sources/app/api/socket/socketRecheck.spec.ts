import { beforeEach, describe, expect, it, vi } from 'vitest';

const authorizeDevice = vi.fn();
vi.mock('@/app/auth/authz/authz', () => ({
    authorizeDevice: (...a: unknown[]) => authorizeDevice(...a),
    forbiddenBody: (d: { reason: string | null }) => ({ error: 'forbidden', reason: d.reason }),
}));

vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { recheckSocketAuthorization } from './socketRecheck';
import { UNAVAILABLE_REASON } from '@/app/auth/authz/authzWebhook';

const makeSocket = () => ({ data: { deviceId: 'd1' }, emit: vi.fn(), disconnect: vi.fn() });

describe('recheckSocketAuthorization', () => {
    beforeEach(() => { authorizeDevice.mockReset(); });

    it('does nothing when the device is still allowed', async () => {
        authorizeDevice.mockResolvedValue({ allowed: true });
        const socket = makeSocket();
        await recheckSocketAuthorization(socket as never);
        expect(authorizeDevice).toHaveBeenCalledWith('d1');
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('tells the client why and disconnects on a denial', async () => {
        authorizeDevice.mockResolvedValue({ allowed: false, reason: 'no access' });
        const socket = makeSocket();
        await recheckSocketAuthorization(socket as never);
        expect(socket.emit).toHaveBeenCalledWith('forbidden', { error: 'forbidden', reason: 'no access' });
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('fails closed when the check throws', async () => {
        authorizeDevice.mockRejectedValue(new Error('boom'));
        const socket = makeSocket();
        await recheckSocketAuthorization(socket as never);
        expect(socket.emit).toHaveBeenCalledWith('forbidden', { error: 'forbidden', reason: UNAVAILABLE_REASON });
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
});
