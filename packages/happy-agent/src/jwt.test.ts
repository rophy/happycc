import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry } from './jwt';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('decodeJwtExpiry', () => {
    it('returns exp in milliseconds', () => {
        expect(decodeJwtExpiry(`${b64({ alg: 'HS256' })}.${b64({ exp: 1_800_000_000 })}.sig`)).toBe(1_800_000_000_000);
    });
    it('returns null for non-JWTs and a missing exp', () => {
        expect(decodeJwtExpiry('fake-token')).toBeNull();
        expect(decodeJwtExpiry(`${b64({})}.${b64({ sub: 'x' })}.sig`)).toBeNull();
        expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
    });
});
