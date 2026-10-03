import { describe, expect, it } from 'vitest';
import { loadAuthConfig, parseDuration } from './authConfig';

const base = {
    OIDC_ISSUER: 'https://idp.corp.example/realms/main',
    OIDC_CLIENT_ID: 'happy-server',
    OIDC_CLIENT_SECRET: 's3cret',
    PUBLIC_URL: 'https://happy.corp.example/',
    WEBAPP_URL: 'https://app.corp.example/',
    HANDY_MASTER_SECRET: 'x'.repeat(32),
};

describe('parseDuration', () => {
    it('parses s/m/h/d', () => {
        expect(parseDuration('45s')).toBe(45);
        expect(parseDuration('15m')).toBe(900);
        expect(parseDuration('2h')).toBe(7200);
        expect(parseDuration('30d')).toBe(2_592_000);
    });
    it('rejects garbage', () => {
        expect(() => parseDuration('15')).toThrow('Invalid duration');
        expect(() => parseDuration('1w')).toThrow('Invalid duration');
    });
});

describe('loadAuthConfig', () => {
    it('applies defaults and trims trailing slashes', () => {
        const cfg = loadAuthConfig(base);
        expect(cfg).toEqual({
            issuer: 'https://idp.corp.example/realms/main',
            clientId: 'happy-server',
            clientSecret: 's3cret',
            scopes: 'openid profile email offline_access',
            publicUrl: 'https://happy.corp.example',
            webappUrl: 'https://app.corp.example',
            mobileRedirectUris: [],
            mobileAppName: 'the happycc app',
            accessTokenTtlSec: 900,
            maxSessionAgeSec: 2_592_000,
            refreshReuseGraceSec: 60,
            allowInsecureIssuer: false,
            masterSecret: 'x'.repeat(32),
        });
    });

    it('parses optional settings', () => {
        const cfg = loadAuthConfig({
            ...base,
            OIDC_SCOPES: 'openid email',
            MOBILE_REDIRECT_URIS: 'corpapp://auth/callback, corpapp-dev://auth/callback',
            MOBILE_APP_NAME: '  Acme Happy  ',
            AUTH_ACCESS_TOKEN_TTL: '5m',
            AUTH_MAX_SESSION_AGE: '7d',
            AUTH_REFRESH_REUSE_GRACE: '0s',
            OIDC_ALLOW_INSECURE_ISSUER: 'true',
        });
        expect(cfg.scopes).toBe('openid email');
        expect(cfg.mobileRedirectUris).toEqual(['corpapp://auth/callback', 'corpapp-dev://auth/callback']);
        expect(cfg.mobileAppName).toBe('Acme Happy');
        expect(cfg.accessTokenTtlSec).toBe(300);
        expect(cfg.maxSessionAgeSec).toBe(604_800);
        expect(cfg.refreshReuseGraceSec).toBe(0);
        expect(cfg.allowInsecureIssuer).toBe(true);
    });

    it('falls back to a default mobile app name when unset or blank', () => {
        expect(loadAuthConfig(base).mobileAppName).toBe('the happycc app');
        expect(loadAuthConfig({ ...base, MOBILE_APP_NAME: '   ' }).mobileAppName).toBe('the happycc app');
    });

    it.each(['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL', 'WEBAPP_URL', 'HANDY_MASTER_SECRET'])(
        'fails when %s is missing', (name) => {
            const env: Record<string, string> = { ...base };
            delete env[name];
            expect(() => loadAuthConfig(env)).toThrow(`${name} is required`);
        });

    it('rejects a short master secret', () => {
        expect(() => loadAuthConfig({ ...base, HANDY_MASTER_SECRET: 'short' }))
            .toThrow('HANDY_MASTER_SECRET must be at least 32 characters');
    });

    it('rejects an http issuer unless explicitly allowed', () => {
        expect(() => loadAuthConfig({ ...base, OIDC_ISSUER: 'http://localhost:8180/realms/happy' }))
            .toThrow('OIDC_ISSUER must use https');
    });
});
