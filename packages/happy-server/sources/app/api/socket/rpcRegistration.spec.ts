import { describe, expect, it } from 'vitest';
import { canRegisterRpc } from './rpcRegistration';

const session = { clientType: 'session-scoped', sessionId: 's1' };

describe('canRegisterRpc', () => {
    it.each(['s1:permission', 's1:bash', 's1:goal-action'])('allows own session method %s', (m) => {
        expect(canRegisterRpc(m, session)).toBe(true);
    });
    it('refuses another session', () => {
        expect(canRegisterRpc('s2:permission', session)).toBe(false);
    });
    it('refuses unprefixed or empty-suffix methods', () => {
        expect(canRegisterRpc('permission', session)).toBe(false);
        expect(canRegisterRpc('s1:', session)).toBe(false);
    });
    it('refuses machine-scoped', () => {
        expect(canRegisterRpc('m1:spawn-happy-session', { clientType: 'machine-scoped', sessionId: undefined })).toBe(false);
    });
    it('refuses user-scoped', () => {
        expect(canRegisterRpc('s1:permission', { clientType: 'user-scoped', sessionId: 's1' })).toBe(false);
    });
    it('refuses missing sessionId', () => {
        expect(canRegisterRpc('s1:permission', { clientType: 'session-scoped' })).toBe(false);
    });
});
