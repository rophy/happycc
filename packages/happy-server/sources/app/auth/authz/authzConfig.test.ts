import { describe, expect, it } from 'vitest';
import { loadAuthzConfig } from './authzConfig';

describe('loadAuthzConfig', () => {
    it('is off without a URL', () => {
        expect(loadAuthzConfig({})).toBeNull();
        expect(loadAuthzConfig({ AUTHZ_WEBHOOK_URL: '  ' })).toBeNull();
    });

    it('reads the URL, secret and durations with defaults', () => {
        expect(loadAuthzConfig({ AUTHZ_WEBHOOK_URL: 'https://authz.test/check', AUTHZ_WEBHOOK_SECRET: 's' })).toEqual({
            url: 'https://authz.test/check', secret: 's', cacheTtlMs: 60_000, timeoutMs: 5_000,
        });
        expect(loadAuthzConfig({
            AUTHZ_WEBHOOK_URL: 'https://authz.test/check', AUTHZ_WEBHOOK_SECRET: 's',
            AUTHZ_WEBHOOK_CACHE_TTL: '1s', AUTHZ_WEBHOOK_TIMEOUT: '2s',
        })).toMatchObject({ cacheTtlMs: 1_000, timeoutMs: 2_000 });
    });

    it('requires a secret and https', () => {
        expect(() => loadAuthzConfig({ AUTHZ_WEBHOOK_URL: 'https://authz.test' })).toThrow(/AUTHZ_WEBHOOK_SECRET/);
        expect(() => loadAuthzConfig({ AUTHZ_WEBHOOK_URL: 'http://authz.test', AUTHZ_WEBHOOK_SECRET: 's' })).toThrow(/https/);
        expect(loadAuthzConfig({
            AUTHZ_WEBHOOK_URL: 'http://localhost:8190', AUTHZ_WEBHOOK_SECRET: 's', AUTHZ_WEBHOOK_ALLOW_INSECURE: 'true',
        })?.url).toBe('http://localhost:8190');
    });
});
