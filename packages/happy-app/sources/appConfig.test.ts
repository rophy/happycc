import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildExpoConfig } = require('../expoConfig.cjs') as {
    buildExpoConfig: (env: Record<string, string | undefined>, meta?: Record<string, string>) => { expo: any };
};

const production = {
    APP_ENV: 'production',
    APP_BUNDLE_ID: 'com.acme.happy',
    APP_SCHEME: 'acmehappy',
    HAPPY_SERVER_URL: 'https://happy.acme.example',
};

const UPSTREAM_IDENTIFIERS = ['com.slopus', 'com.ex3ndr', 'bulkacorp', '4558dd3d', 'app.happy.engineering', 'google-services.json'];

describe('buildExpoConfig', () => {
    it('builds development with placeholder identities and no upstream identifiers', () => {
        const { expo } = buildExpoConfig({});
        expect(expo.name).toBe('Happy (dev)');
        expect(expo.scheme).toBe('happy-dev');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.dev');
        expect(expo.android.package).toBe('com.example.happy.dev');
        expect(expo.updates).toBeUndefined();
        expect(expo.owner).toBeUndefined();
        expect(expo.extra.eas).toBeUndefined();
        expect(expo.ios.associatedDomains).toBeUndefined();
        expect(expo.android.intentFilters).toEqual([]);
        expect(expo.android.googleServicesFile).toBeUndefined();
        const serialized = JSON.stringify(expo);
        for (const id of UPSTREAM_IDENTIFIERS) {
            expect(serialized).not.toContain(id);
        }
    });

    it('builds preview with its own placeholders', () => {
        const { expo } = buildExpoConfig({ APP_ENV: 'preview' });
        expect(expo.name).toBe('Happy (preview)');
        expect(expo.scheme).toBe('happy-preview');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.preview');
    });

    it.each(['APP_BUNDLE_ID', 'APP_SCHEME', 'HAPPY_SERVER_URL'])('fails a production build without %s', (name) => {
        expect(() => buildExpoConfig({ ...production, [name]: undefined })).toThrow(new RegExp(`Production builds require .*${name}`));
        expect(() => buildExpoConfig({ ...production, [name]: '   ' })).toThrow(/Production builds require/);
    });

    it('lists every missing production variable at once', () => {
        expect(() => buildExpoConfig({ APP_ENV: 'production' })).toThrow('APP_BUNDLE_ID, APP_SCHEME, HAPPY_SERVER_URL');
    });

    it('uses the configured identity in production', () => {
        const { expo } = buildExpoConfig({ ...production, APP_NAME: 'Acme Happy' });
        expect(expo.name).toBe('Acme Happy');
        expect(expo.scheme).toBe('acmehappy');
        expect(expo.ios.bundleIdentifier).toBe('com.acme.happy');
        expect(expo.android.package).toBe('com.acme.happy');
        expect(expo.ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
        expect(expo.extra.app.consoleLoggingDefault).toBe(false);
    });

    it('emits associated domains and intent filters only with APP_LINKS_HOST', () => {
        const { expo } = buildExpoConfig({ ...production, APP_LINKS_HOST: 'links.acme.example' });
        expect(expo.ios.associatedDomains).toEqual(['applinks:links.acme.example']);
        expect(expo.android.intentFilters).toEqual([{
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host: 'links.acme.example', pathPrefix: '/' }],
            category: ['BROWSABLE', 'DEFAULT'],
        }]);
    });

    it('configures EAS updates, project and owner only when set', () => {
        const { expo } = buildExpoConfig({ ...production, EAS_PROJECT_ID: 'proj-123', EAS_OWNER: 'acme' });
        expect(expo.updates).toEqual({ url: 'https://u.expo.dev/proj-123', requestHeaders: { 'expo-channel-name': 'production' } });
        expect(expo.extra.eas).toEqual({ projectId: 'proj-123' });
        expect(expo.owner).toBe('acme');
    });

    it('takes the Google services file and assets directory from the environment', () => {
        const { expo } = buildExpoConfig({ ...production, GOOGLE_SERVICES_FILE: './acme/google-services.json', APP_ASSETS_DIR: './acme/assets/' });
        expect(expo.android.googleServicesFile).toBe('./acme/google-services.json');
        expect(expo.icon).toBe('./acme/assets/icon.png');
        expect(expo.android.adaptiveIcon.foregroundImage).toBe('./acme/assets/icon-adaptive.png');
        expect(expo.web.favicon).toBe('./acme/assets/favicon.png');
    });

    it('takes the slug from APP_SLUG, defaulting to happy', () => {
        expect(buildExpoConfig(production).expo.slug).toBe('happy');
        expect(buildExpoConfig({ ...production, APP_SLUG: 'acme-happy' }).expo.slug).toBe('acme-happy');
    });

    it('rejects an unknown APP_ENV', () => {
        expect(() => buildExpoConfig({ APP_ENV: 'staging' })).toThrow(/Unknown APP_ENV "staging"/);
    });

    it('requests no microphone or camera access and loads no voice plugins', () => {
        const { expo } = buildExpoConfig({});
        expect(expo.ios.infoPlist).not.toHaveProperty('NSMicrophoneUsageDescription');
        expect(expo.ios.infoPlist).not.toHaveProperty('NSCameraUsageDescription');
        expect(expo.android.permissions).not.toContain('android.permission.RECORD_AUDIO');
        expect(expo.android.permissions).not.toContain('android.permission.CAMERA');
        const picker = expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-image-picker');
        expect(picker?.[1]).toEqual({ cameraPermission: false, microphonePermission: false });
        const pluginNames = expo.plugins.map((p: unknown) => (Array.isArray(p) ? p[0] : p)).filter((p: unknown) => typeof p === 'string');
        for (const removed of ['expo-audio', 'expo-camera', 'react-native-vision-camera', 'react-native-audio-api', '@livekit/react-native-expo-plugin', '@config-plugins/react-native-webrtc']) {
            expect(pluginNames).not.toContain(removed);
        }
    });

    it('passes build metadata through', () => {
        const { expo } = buildExpoConfig({}, { commitSha: 'abc', commitTimestamp: '2026-10-01T00:00:00Z' });
        expect(expo.extra.app.buildCommitSha).toBe('abc');
        expect(expo.extra.app.buildCommitTimestamp).toBe('2026-10-01T00:00:00Z');
    });

    it('carries no RevenueCat keys', () => {
        const { expo } = buildExpoConfig({ EXPO_PUBLIC_REVENUE_CAT_APPLE: 'appl_x', EXPO_PUBLIC_REVENUE_CAT_GOOGLE: 'goog_x', EXPO_PUBLIC_REVENUE_CAT_STRIPE: 'strp_x' });
        for (const key of ['revenueCatAppleKey', 'revenueCatGoogleKey', 'revenueCatStripeKey']) {
            expect(expo.extra.app).not.toHaveProperty(key);
        }
    });

    it('carries analytics and Claude connect settings only when set', () => {
        const off = buildExpoConfig({}).expo.extra.app;
        expect(off.postHogKey).toBeUndefined();
        expect(off.postHogHost).toBeUndefined();
        expect(off.enableClaudeConnect).toBe(false);

        const on = buildExpoConfig({
            EXPO_PUBLIC_POSTHOG_API_KEY: 'phc_test',
            EXPO_PUBLIC_POSTHOG_HOST: 'https://posthog.corp.example',
            EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: '1',
        }).expo.extra.app;
        expect(on).toMatchObject({ postHogKey: 'phc_test', postHogHost: 'https://posthog.corp.example', enableClaudeConnect: true });
    });
});
