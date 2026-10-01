import { describe, expect, it } from 'vitest';
import { DEV_FALLBACK_SERVER_URL, resolveServerUrl } from './serverUrl';

describe('resolveServerUrl', () => {
    it('prefers the deploy-time URL over the build-time URL', () => {
        expect(resolveServerUrl({ deployUrl: 'https://deploy.example', buildUrl: 'https://build.example' })).toBe('https://deploy.example');
    });
    it('uses the build-time URL when no deploy-time URL exists', () => {
        expect(resolveServerUrl({ deployUrl: undefined, buildUrl: 'https://build.example/' })).toBe('https://build.example');
        expect(resolveServerUrl({ deployUrl: '  ', buildUrl: 'https://build.example' })).toBe('https://build.example');
        expect(resolveServerUrl({ deployUrl: 42, buildUrl: 'https://build.example' })).toBe('https://build.example');
    });
    it('falls back to the local development server, never an upstream host', () => {
        expect(resolveServerUrl({})).toBe(DEV_FALLBACK_SERVER_URL);
        expect(DEV_FALLBACK_SERVER_URL).toBe('http://localhost:3005');
    });
});
