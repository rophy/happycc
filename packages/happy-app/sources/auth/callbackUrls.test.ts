import { describe, expect, it } from 'vitest';
import { isAuthCallbackPath, isMobileCallbackDenied, parseMobileCallbackUrl, parseWebCallbackHash } from './callbackUrls';

describe('parseWebCallbackHash', () => {
    it('reads the exchange code from the fragment', () => {
        expect(parseWebCallbackHash('#code=abc_DEF-123')).toBe('abc_DEF-123');
        expect(parseWebCallbackHash('code=a%2Bb')).toBe('a+b');
    });
    it('returns null without a code', () => {
        expect(parseWebCallbackHash('')).toBeNull();
        expect(parseWebCallbackHash('#error=access_denied')).toBeNull();
        expect(parseWebCallbackHash('#code=')).toBeNull();
    });
});

describe('parseMobileCallbackUrl', () => {
    const redirect = 'corpapp://auth/callback';
    it('reads the code from the configured redirect URI', () => {
        expect(parseMobileCallbackUrl('corpapp://auth/callback?code=xyz', redirect)).toBe('xyz');
    });
    it('ignores other URLs and missing codes', () => {
        expect(parseMobileCallbackUrl('evil://auth/callback?code=xyz', redirect)).toBeNull();
        expect(parseMobileCallbackUrl('corpapp://auth/callback', redirect)).toBeNull();
        expect(parseMobileCallbackUrl('corpapp://auth/callback?state=1', redirect)).toBeNull();
    });
});

describe('isMobileCallbackDenied', () => {
    const redirect = 'corpapp://auth/callback';
    it('detects a decline redirect', () => {
        expect(isMobileCallbackDenied('corpapp://auth/callback?error=access_denied', redirect)).toBe(true);
    });
    it('ignores other URLs, missing errors, and other error values', () => {
        expect(isMobileCallbackDenied('evil://auth/callback?error=access_denied', redirect)).toBe(false);
        expect(isMobileCallbackDenied('corpapp://auth/callback?code=xyz', redirect)).toBe(false);
        expect(isMobileCallbackDenied('corpapp://auth/callback?error=server_error', redirect)).toBe(false);
    });
});

describe('isAuthCallbackPath', () => {
    it('matches the callback as a URL or a router path', () => {
        expect(isAuthCallbackPath('corpapp://auth/callback?code=1')).toBe(true);
        expect(isAuthCallbackPath('/auth/callback?code=1')).toBe(true);
        expect(isAuthCallbackPath('auth/callback')).toBe(true);
    });
    it('does not match other paths', () => {
        expect(isAuthCallbackPath('/session/abc')).toBe(false);
        expect(isAuthCallbackPath('/auth/callbacks')).toBe(false);
        expect(isAuthCallbackPath('corpapp://session/auth/callback')).toBe(false);
    });
});
