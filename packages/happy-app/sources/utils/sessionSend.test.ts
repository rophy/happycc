import { describe, expect, it } from 'vitest';
import { isSendBlockedForStoppedSession } from './sessionSend';

describe('isSendBlockedForStoppedSession', () => {
    it('blocks sending to a stopped session in a workstation-only build', () => {
        expect(isSendBlockedForStoppedSession({ active: false }, true)).toBe(true);
    });

    it('allows sending to a running session, even while it is briefly offline', () => {
        expect(isSendBlockedForStoppedSession({ active: true }, true)).toBe(false);
    });

    it('keeps upstream behaviour when the build can resume sessions itself', () => {
        expect(isSendBlockedForStoppedSession({ active: false }, false)).toBe(false);
    });

    it('does not block a chat that has no session yet', () => {
        expect(isSendBlockedForStoppedSession(null, true)).toBe(false);
    });
});
