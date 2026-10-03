import { describe, it, expect } from 'vitest';
import { poll, extractUrl, shellQuote } from './stack';

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
    it('strips ANSI escapes around and inside the text', () => {
        expect(extractUrl('\x1b[36m\x1b[4mhttp://localhost:3005/activate?code=AB-CD\x1b[0m\x1b[39m', /activate/)).toBe('http://localhost:3005/activate?code=AB-CD');
    });
    it('trims trailing punctuation', () => {
        expect(extractUrl('(see http://localhost:3005/activate?code=AB-CD).', /activate/)).toBe('http://localhost:3005/activate?code=AB-CD');
        expect(extractUrl('go to http://localhost:3005/v1/auth/oidc/login?a=1&b=2, now', /oidc\/login/)).toBe('http://localhost:3005/v1/auth/oidc/login?a=1&b=2');
    });
    it('returns undefined when nothing matches', () => {
        expect(extractUrl('http://example.com/other and plain text', /activate/)).toBeUndefined();
        expect(extractUrl('', /x/)).toBeUndefined();
    });
});

describe('shellQuote', () => {
    it('wraps in single quotes', () => {
        expect(shellQuote('http://a/b?x=1&y=2')).toBe("'http://a/b?x=1&y=2'");
    });
    it('escapes embedded single quotes and neutralises shell metacharacters', () => {
        expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
        expect(shellQuote('$(rm -rf /); `x` "y"')).toBe(`'$(rm -rf /); \`x\` "y"'`);
    });
});
