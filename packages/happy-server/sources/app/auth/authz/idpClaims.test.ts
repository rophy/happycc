import { describe, expect, it } from 'vitest';
import { filterIdpClaims } from './idpClaims';

describe('filterIdpClaims', () => {
    it('drops token bookkeeping claims and keeps the rest', () => {
        expect(filterIdpClaims({
            iss: 'i', sub: 's', aud: 'a', exp: 1, iat: 1, nonce: 'n', at_hash: 'h', auth_time: 1,
            email: 'a@example.com', groups: ['g1'], name: 'A',
        })).toEqual({ email: 'a@example.com', groups: ['g1'], name: 'A' });
    });
});
