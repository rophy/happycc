import { describe, expect, it } from 'vitest';
import { resolveAccessToken } from './tokenSource';

describe('resolveAccessToken', () => {
    it('supports fixed strings and live getters', () => {
        let current = 'a';
        expect(resolveAccessToken('fixed')).toBe('fixed');
        const source = () => current;
        expect(resolveAccessToken(source)).toBe('a');
        current = 'b';
        expect(resolveAccessToken(source)).toBe('b');
    });
});
