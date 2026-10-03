import { describe, it, expect } from 'vitest';
import { poll, extractUrl } from './stack';

describe('poll', () => {
    it('returns the first defined value', async () => {
        let n = 0;
        await expect(poll(async () => (++n === 3 ? 'ok' : undefined), { timeoutMs: 1000, intervalMs: 1, what: 'x' })).resolves.toBe('ok');
    });
    it('times out naming what it waited for', async () => {
        await expect(poll(async () => undefined, { timeoutMs: 20, intervalMs: 5, what: 'the reply' })).rejects.toThrow('Timed out waiting for the reply');
    });
});

describe('extractUrl', () => {
    it('finds the first URL matching a pattern', () => {
        expect(extractUrl('open\n  http://localhost:3005/activate?code=AB-CD\nthen', /\/activate\?code=/)).toBe('http://localhost:3005/activate?code=AB-CD');
    });
});
