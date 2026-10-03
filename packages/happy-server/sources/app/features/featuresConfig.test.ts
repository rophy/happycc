import { describe, expect, it } from 'vitest';
import { describeFeatures, loadFeaturesConfig, publicFeatures } from './featuresConfig';

const githubEnv = {
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_REDIRECT_URL: 'https://happy.corp.example/v1/connect/github/callback',
};

describe('loadFeaturesConfig', () => {
    it('turns every integration off except push by default', () => {
        const cfg = loadFeaturesConfig({});
        expect(cfg).toEqual({ github: null, pushEnabled: true });
        expect(publicFeatures(cfg)).toEqual({ githubConnect: false, push: true });
    });

    it('treats blank values as unset', () => {
        expect(loadFeaturesConfig({ GITHUB_CLIENT_ID: '  ', GITHUB_CLIENT_SECRET: '', GITHUB_REDIRECT_URL: ' ' }).github).toBeNull();
    });

    it('ignores leftover voice settings now that voice is removed', () => {
        expect(loadFeaturesConfig({ ELEVENLABS_API_KEY: 'xi-key', ELEVENLABS_AGENT_ID: 'agent_corp', VOICE_MONTHLY_LIMIT_MINUTES: 'lots' })).toEqual({ github: null, pushEnabled: true });
    });

    it('enables GitHub connect only when all OAuth settings are set', () => {
        expect(loadFeaturesConfig(githubEnv).github).toEqual({
            clientId: 'gh-client',
            clientSecret: 'gh-secret',
            redirectUrl: 'https://happy.corp.example/v1/connect/github/callback',
        });
        expect(() => loadFeaturesConfig({ GITHUB_CLIENT_ID: 'gh-client' })).toThrow('GITHUB_CLIENT_SECRET');
        expect(() => loadFeaturesConfig({ GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: 'gh-secret' })).toThrow('GITHUB_REDIRECT_URL');
    });

    it('parses PUSH_ENABLED', () => {
        for (const off of ['false', 'FALSE', '0']) {
            expect(loadFeaturesConfig({ PUSH_ENABLED: off }).pushEnabled).toBe(false);
        }
        for (const on of ['true', 'True', '1']) {
            expect(loadFeaturesConfig({ PUSH_ENABLED: on }).pushEnabled).toBe(true);
        }
        expect(() => loadFeaturesConfig({ PUSH_ENABLED: 'nope' })).toThrow('PUSH_ENABLED');
    });

    it('never puts values into errors or the startup summary', () => {
        expect(() => loadFeaturesConfig({ GITHUB_CLIENT_SECRET: 'gh-very-secret' })).toThrow(/^(?!.*gh-very-secret)/);
        const text = describeFeatures(loadFeaturesConfig({ ...githubEnv, PUSH_ENABLED: 'false' }));
        expect(text).toBe('githubConnect=on push=off');
        expect(text).not.toContain('secret');
        expect(describeFeatures(loadFeaturesConfig({}))).toBe('githubConnect=off push=on');
    });
});
