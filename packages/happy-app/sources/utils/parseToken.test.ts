import { describe, expect, it } from 'vitest';
import { parseToken } from './parseToken';

describe('parseToken', () => {
    it('reads sub from a server access token whose payload uses base64url characters', () => {
        const payload = Buffer.from(JSON.stringify({ sub: 'cmacc123', did: 'dev', typ: 'access', note: '???>>>~~~' })).toString('base64url');
        expect(payload).toMatch(/[-_]/);
        expect(parseToken(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`)).toBe('cmacc123');
    });
});
