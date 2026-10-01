import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry, decodeJwtPayload } from './jwt';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('decodeJwtPayload / decodeJwtExpiry', () => {
    it('decodes base64url payloads, including "-" and "_" and missing padding', () => {
        const payload = { sub: 'cmacc123', did: 'dev', typ: 'access', note: '???>>>~~~', exp: 1_800_000_000 };
        const segment = b64url(payload);
        expect(segment).toMatch(/[-_]/);
        const token = `${b64url({ alg: 'HS256' })}.${segment}.sig`;
        expect(decodeJwtPayload(token)).toEqual(payload);
        expect(decodeJwtExpiry(token)).toBe(1_800_000_000_000);
    });

    it('returns null for non-JWTs and tokens without a numeric exp', () => {
        expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
        expect(decodeJwtExpiry(`${b64url({})}.${b64url({ sub: 'x' })}.sig`)).toBeNull();
        expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
        expect(decodeJwtPayload('a..c')).toBeNull();
    });
});
