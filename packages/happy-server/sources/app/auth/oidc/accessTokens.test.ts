import { beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAccessToken, generateOpaqueToken, hashToken, initAccessTokens, verifyAccessToken } from './accessTokens';

const masterSecret = 'test-master-secret-that-is-long-enough-000';

beforeAll(() => initAccessTokens({ masterSecret, ttlSec: 900 }));

describe('accessTokens', () => {
    it('round-trips user and device', () => {
        const token = createAccessToken({ userId: 'acc_1', deviceId: 'dev_1' });
        expect(verifyAccessToken(token)).toEqual({ userId: 'acc_1', deviceId: 'dev_1' });
    });

    it('rejects expired tokens', () => {
        vi.useFakeTimers();
        try {
            const token = createAccessToken({ userId: 'acc_1', deviceId: 'dev_1' });
            vi.advanceTimersByTime(901_000);
            expect(verifyAccessToken(token)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects tokens signed with another key', () => {
        const forged = jwt.sign({ did: 'dev_1', typ: 'access' }, 'other-key', { subject: 'acc_1', algorithm: 'HS256' });
        expect(verifyAccessToken(forged)).toBeNull();
    });

    it('rejects alg=none tokens', () => {
        const unsigned = jwt.sign({ did: 'dev_1', typ: 'access', sub: 'acc_1' }, '', { algorithm: 'none' });
        expect(verifyAccessToken(unsigned)).toBeNull();
    });

    it('rejects garbage', () => {
        expect(verifyAccessToken('not-a-token')).toBeNull();
    });

    it('generates unique opaque tokens and stable hashes', () => {
        const a = generateOpaqueToken();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(generateOpaqueToken()).not.toBe(a);
        expect(hashToken(a)).toBe(hashToken(a));
        expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    });
});
