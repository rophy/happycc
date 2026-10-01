import { describe, expect, it } from 'vitest';
import { describeFeatures, loadFeaturesConfig, publicFeatures } from './featuresConfig';

const voiceEnv = { ELEVENLABS_API_KEY: 'xi-key', ELEVENLABS_AGENT_ID: 'agent_corp' };
const githubEnv = {
    GITHUB_CLIENT_ID: 'gh-client',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_REDIRECT_URL: 'https://happy.corp.example/v1/connect/github/callback',
};

describe('loadFeaturesConfig', () => {
    it('turns every integration off except push by default', () => {
        const cfg = loadFeaturesConfig({});
        expect(cfg).toEqual({ voice: null, github: null, pushEnabled: true });
        expect(publicFeatures(cfg)).toEqual({ voice: false, githubConnect: false, push: true });
    });

    it('enables voice only when both ElevenLabs settings are set', () => {
        expect(loadFeaturesConfig(voiceEnv).voice).toEqual({ apiKey: 'xi-key', agentId: 'agent_corp', monthlyLimitSeconds: null });
        expect(() => loadFeaturesConfig({ ELEVENLABS_API_KEY: 'xi-key' })).toThrow('ELEVENLABS_AGENT_ID');
        expect(() => loadFeaturesConfig({ ELEVENLABS_AGENT_ID: 'agent_corp' })).toThrow('ELEVENLABS_API_KEY');
    });

    it('treats blank values as unset', () => {
        expect(loadFeaturesConfig({ ELEVENLABS_API_KEY: '  ', ELEVENLABS_AGENT_ID: '' }).voice).toBeNull();
    });

    it('parses VOICE_MONTHLY_LIMIT_MINUTES as a positive whole number', () => {
        expect(loadFeaturesConfig({ ...voiceEnv, VOICE_MONTHLY_LIMIT_MINUTES: '90' }).voice?.monthlyLimitSeconds).toBe(5400);
        for (const bad of ['0', '-5', '1.5', 'lots']) {
            expect(() => loadFeaturesConfig({ ...voiceEnv, VOICE_MONTHLY_LIMIT_MINUTES: bad })).toThrow('VOICE_MONTHLY_LIMIT_MINUTES');
        }
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
        expect(() => loadFeaturesConfig({ ELEVENLABS_API_KEY: 'xi-very-secret' })).toThrow(/^(?!.*xi-very-secret)/);
        const text = describeFeatures(loadFeaturesConfig({ ...voiceEnv, ...githubEnv, VOICE_MONTHLY_LIMIT_MINUTES: '60', PUSH_ENABLED: 'false' }));
        expect(text).toBe('voice=on (cap 60 min/30 days) githubConnect=on push=off');
        expect(text).not.toContain('secret');
        expect(describeFeatures(loadFeaturesConfig({}))).toBe('voice=off githubConnect=off push=on');
    });
});
