import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildExpoConfig } = require('../expoConfig.cjs') as {
    buildExpoConfig: (
        env: Record<string, string | undefined>,
        meta?: Record<string, string>,
        options?: { configFile?: { path: string; contents: string } | null; projectRoot?: string; readFile?: (file: string) => Buffer },
    ) => { expo: any };
};

const PROJECT_ROOT = '/repo/packages/happy-app';
const CONFIG_PATH = '/repo/deploy/app-config/acme.json';

const productionConfig = {
    bundleId: 'com.acme.happy',
    scheme: 'acmehappy',
    serverUrl: 'https://happy.acme.example',
};

/** Builds with an in-memory APP_CONFIG file, the way app.config.js passes one in. */
function build(config: unknown, env: Record<string, string | undefined> = { APP_ENV: 'production' }, meta?: Record<string, string>) {
    const contents = typeof config === 'string' ? config : JSON.stringify(config);
    return buildExpoConfig(env, meta, { configFile: { path: CONFIG_PATH, contents }, projectRoot: PROJECT_ROOT }).expo;
}

const UPSTREAM_IDENTIFIERS = ['com.slopus', 'com.ex3ndr', 'bulkacorp', '4558dd3d', 'app.happy.engineering', 'google-services.json', 'slopus'];

describe('buildExpoConfig', () => {
    it('builds development without a config file, with placeholder identities and no upstream identifiers', () => {
        const { expo } = buildExpoConfig({});
        expect(expo.name).toBe('happycc (dev)');
        expect(expo.slug).toBe('happy');
        expect(expo.scheme).toBe('happy-dev');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.dev');
        expect(expo.android.package).toBe('com.example.happy.dev');
        expect(expo.icon).toBe('./sources/assets/images/icon.png');
        expect(expo.updates).toBeUndefined();
        expect(expo.owner).toBeUndefined();
        expect(expo.extra.eas).toBeUndefined();
        expect(expo.ios.associatedDomains).toBeUndefined();
        expect(expo.android.intentFilters).toEqual([]);
        expect(expo.android.googleServicesFile).toBeUndefined();
        expect(expo.extra.app.serverUrl).toBeUndefined();
        const serialized = JSON.stringify(expo);
        for (const id of UPSTREAM_IDENTIFIERS) {
            expect(serialized).not.toContain(id);
        }
    });

    it('builds preview with its own placeholders', () => {
        const { expo } = buildExpoConfig({ APP_ENV: 'preview' });
        expect(expo.name).toBe('happycc (preview)');
        expect(expo.scheme).toBe('happy-preview');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.preview');
    });

    it('lets a development config file override only what it sets', () => {
        const expo = build({ serverUrl: 'http://localhost:3006' }, {});
        expect(expo.name).toBe('happycc (dev)');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.dev');
        expect(expo.extra.app.serverUrl).toBe('http://localhost:3006');
    });

    it('fails a production build without a config file', () => {
        expect(() => buildExpoConfig({ APP_ENV: 'production' })).toThrow(/Production builds require APP_CONFIG/);
    });

    it.each(['bundleId', 'scheme', 'serverUrl'])('fails a production build whose config has no %s', (key) => {
        const config: Record<string, string> = { ...productionConfig };
        delete config[key];
        expect(() => build(config)).toThrow(new RegExp(`Production builds require ${key} in APP_CONFIG`));
    });

    it('lists every missing production field at once', () => {
        expect(() => build({})).toThrow('bundleId, scheme, serverUrl');
    });

    it('uses the configured identity in production', () => {
        const expo = build({ ...productionConfig, name: 'Acme Happy', slug: 'acme-happy' });
        expect(expo.name).toBe('Acme Happy');
        expect(expo.slug).toBe('acme-happy');
        expect(expo.scheme).toBe('acmehappy');
        expect(expo.ios.bundleIdentifier).toBe('com.acme.happy');
        expect(expo.android.package).toBe('com.acme.happy');
        expect(expo.ios.infoPlist.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
        expect(expo.extra.app.consoleLoggingDefault).toBe(false);
        expect(expo.extra.app.serverUrl).toBe('https://happy.acme.example');
    });

    it('emits associated domains and intent filters only with linksHost', () => {
        const expo = build({ ...productionConfig, linksHost: 'links.acme.example' });
        expect(expo.ios.associatedDomains).toEqual(['applinks:links.acme.example']);
        expect(expo.android.intentFilters).toEqual([{
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host: 'links.acme.example', pathPrefix: '/' }],
            category: ['BROWSABLE', 'DEFAULT'],
        }]);
    });

    it('configures EAS updates, project and owner only when set', () => {
        const expo = build({ ...productionConfig, eas: { projectId: 'proj-123', owner: 'acme' } });
        expect(expo.updates).toEqual({ url: 'https://u.expo.dev/proj-123', requestHeaders: { 'expo-channel-name': 'production' } });
        expect(expo.extra.eas).toEqual({ projectId: 'proj-123' });
        expect(expo.owner).toBe('acme');
    });

    it('resolves relative paths in the file against the file, relative to the project root', () => {
        const expo = build({ ...productionConfig, googleServicesFile: './google-services.json', assetsDir: 'assets/' });
        expect(expo.android.googleServicesFile).toBe('../../deploy/app-config/google-services.json');
        expect(expo.icon).toBe('../../deploy/app-config/assets/icon.png');
        expect(expo.android.adaptiveIcon.foregroundImage).toBe('../../deploy/app-config/assets/icon-adaptive.png');
        expect(expo.web.favicon).toBe('../../deploy/app-config/assets/favicon.png');
        expect(build({ ...productionConfig, assetsDir: '/abs/assets' }).icon).toBe('../../../abs/assets/icon.png');
        expect(build({ ...productionConfig, assetsDir: '../../packages/happy-app/brand' }).icon).toBe('./brand/icon.png');
    });

    it('rejects unknown keys, naming them', () => {
        expect(() => build({ ...productionConfig, bundleID: 'x' })).toThrow(/bundleID: unknown key/);
        expect(() => build({ ...productionConfig, links: { discord: 'https://example.com' } })).toThrow(/links\.discord: unknown key/);
    });

    it('rejects wrong types and lists every problem', () => {
        let message = '';
        try {
            build({ ...productionConfig, name: 42, features: { claudeConnect: 'yes' }, eas: 'proj', slug: '' });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain(CONFIG_PATH);
        expect(message).toContain('name: must be a non-empty string');
        expect(message).toContain('features.claudeConnect: must be true or false');
        expect(message).toContain('eas: must be an object');
        expect(message).toContain('slug: must be a non-empty string');
    });

    it('rejects malformed JSON and identifiers', () => {
        expect(() => build('{ not json')).toThrow(/is not valid JSON/);
        expect(() => build({ ...productionConfig, bundleId: 'not a bundle id' })).toThrow(/bundleId: must be a reverse-DNS id/);
        expect(() => build({ ...productionConfig, scheme: 'Acme Happy' })).toThrow(/scheme: must be a lowercase URL scheme/);
        expect(() => build({ ...productionConfig, linksHost: 'https://links.example.com' })).toThrow(/linksHost: must be a bare host name/);
    });

    it('rejects invalid URLs', () => {
        expect(() => build({ ...productionConfig, serverUrl: 'ftp://example.com' })).toThrow(/serverUrl: must be an http/);
        expect(() => build({ ...productionConfig, analytics: { posthogHost: 'http://posthog.example.com' } })).toThrow(/analytics\.posthogHost/);
        expect(() => build({ ...productionConfig, mermaidScriptUrl: 'http://example.com/mermaid.js' })).toThrow(/mermaidScriptUrl: must be an https/);
        for (const bad of ['not a url', 'http://example.com/x', 'javascript:alert(1)', 'ftp://example.com/x', 'http://localhost:8080/x']) {
            expect(() => build({ ...productionConfig, links: { issues: bad } })).toThrow(/links\.issues: must be an https/);
        }
    });

    it('treats Object.prototype names as unknown keys', () => {
        expect(() => build({ ...productionConfig, toString: 'x' })).toThrow(/toString: unknown key/);
        expect(() => build(JSON.parse('{"__proto__": {"x": 1}}'), {})).toThrow(/__proto__: unknown key/);
        expect(() => build({ links: { constructor: 'https://example.com' } }, {})).toThrow(/links\.constructor: unknown key/);
    });

    it('accepts only well-formed host names for linksHost', () => {
        for (const bad of ['..', '-', '.example.com', 'example.com.', 'a..b', '-a.example.com']) {
            expect(() => build({ linksHost: bad }, {})).toThrow(/linksHost: must be a bare host name/);
        }
        expect(build({ linksHost: 'links-1.example.com' }, {}).ios.associatedDomains).toEqual(['applinks:links-1.example.com']);
    });

    it('allows a plain http server only for localhost in production', () => {
        expect(() => build({ ...productionConfig, serverUrl: 'http://happy.acme.example' })).toThrow(/serverUrl: must be https:\/\/ in production/);
        expect(build({ ...productionConfig, serverUrl: 'http://localhost:3005' }).extra.app.serverUrl).toBe('http://localhost:3005');
        expect(build({ serverUrl: 'http://192.168.1.5:3005' }, { APP_ENV: 'preview' }).extra.app.serverUrl).toBe('http://192.168.1.5:3005');
    });

    it('takes a log server URL outside production only', () => {
        expect(build({ logServerUrl: 'http://192.168.1.5:8787/' }, {}).extra.app.logServerUrl).toBe('http://192.168.1.5:8787');
        expect(build(productionConfig).extra.app.logServerUrl).toBeUndefined();
        expect(() => build({ logServerUrl: 'ftp://example.com' }, {})).toThrow(/logServerUrl: must be an http/);
        expect(() => build({ ...productionConfig, logServerUrl: 'http://localhost:8787' })).toThrow(/logServerUrl: is dev tooling/);
    });

    it('carries no links but the default GitHub link unless the config sets them', () => {
        const app = build(productionConfig).extra.app;
        expect(app.githubUrl).toBe('https://github.com/rophy/happy');
        for (const key of ['issuesUrl', 'privacyUrl', 'termsUrl', 'helpUrl']) {
            expect(app[key]).toBeUndefined();
        }
    });

    it('passes configured links through, and null hides one', () => {
        const app = build({
            ...productionConfig,
            links: {
                github: null,
                issues: 'https://example.com/issues',
                privacy: ' https://example.com/privacy ',
                terms: 'https://example.com/terms',
                help: null,
            },
        }).extra.app;
        expect(app.githubUrl).toBeUndefined();
        expect(app.helpUrl).toBeUndefined();
        expect(app).toMatchObject({
            issuesUrl: 'https://example.com/issues',
            privacyUrl: 'https://example.com/privacy',
            termsUrl: 'https://example.com/terms',
        });
    });

    it('allows http localhost links only outside production', () => {
        expect(build({ links: { help: 'http://localhost:8080/help' } }, {}).extra.app.helpUrl).toBe('http://localhost:8080/help');
        expect(build({ links: { help: 'http://127.0.0.1/help' } }, { APP_ENV: 'preview' }).extra.app.helpUrl).toBe('http://127.0.0.1/help');
        expect(() => build({ ...productionConfig, links: { help: 'http://localhost:8080/help' } })).toThrow(/links\.help/);
    });

    it('carries analytics, Claude connect and mermaid settings only when set', () => {
        const off = build(productionConfig).extra.app;
        expect(off.postHogKey).toBeUndefined();
        expect(off.postHogHost).toBeUndefined();
        expect(off.enableClaudeConnect).toBe(false);
        expect(off.mermaidScriptUrl).toBeUndefined();

        const on = build({
            ...productionConfig,
            analytics: { posthogKey: 'phc_test', posthogHost: 'https://posthog.corp.example/' },
            features: { claudeConnect: true },
            mermaidScriptUrl: 'https://assets.example.com/mermaid.min.js',
        }).extra.app;
        expect(on).toMatchObject({
            postHogKey: 'phc_test',
            postHogHost: 'https://posthog.corp.example',
            enableClaudeConnect: true,
            mermaidScriptUrl: 'https://assets.example.com/mermaid.min.js',
        });
    });

    it('ignores the removed environment variables', () => {
        const { expo } = buildExpoConfig({
            APP_NAME: 'Env Name', APP_BUNDLE_ID: 'com.env.happy', HAPPY_SERVER_URL: 'https://env.example.com',
            EXPO_PUBLIC_POSTHOG_API_KEY: 'phc_env', EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: '1',
            EXPO_PUBLIC_LOG_SERVER_URL: 'http://localhost:8787',
        });
        expect(expo.name).toBe('happycc (dev)');
        expect(expo.ios.bundleIdentifier).toBe('com.example.happy.dev');
        expect(expo.extra.app.serverUrl).toBeUndefined();
        expect(expo.extra.app.postHogKey).toBeUndefined();
        expect(expo.extra.app.enableClaudeConnect).toBe(false);
        expect(expo.extra.app.logServerUrl).toBeUndefined();
    });

    it('accepts the committed example and e2e config files', () => {
        const repoRoot = path.resolve(__dirname, '../../..');
        const projectRoot = path.join(repoRoot, 'packages/happy-app');
        for (const file of ['deploy/app-config/org.example.json', 'deploy/app-config/e2e.json']) {
            const configPath = path.join(repoRoot, file);
            const { expo } = buildExpoConfig({ APP_ENV: 'production' }, {}, {
                configFile: { path: configPath, contents: fs.readFileSync(configPath, 'utf8') },
                projectRoot,
            });
            expect(expo.extra.app.serverUrl).toMatch(/^https?:\/\//);
            expect(expo.extra.app.brand.name).toBeTruthy();
        }
    });

    it('names the app after the brand, with the default brand when none is set', () => {
        expect(build(productionConfig).name).toBe('happycc');
        expect(build(productionConfig).extra.app.brand).toEqual({ name: 'happycc', fullName: 'Happy Corporate Coder' });
        const expo = build({ ...productionConfig, brand: { name: 'Acme', fullName: 'Acme Coder Pro' } });
        expect(expo.name).toBe('Acme');
        expect(expo.extra.app.brand).toEqual({ name: 'Acme', fullName: 'Acme Coder Pro' });
        expect(build({ brand: { name: 'Acme' } }, { APP_ENV: 'preview' }).name).toBe('Acme (preview)');
        expect(build({ ...productionConfig, name: 'Acme App', brand: { name: 'Acme' } }).name).toBe('Acme App');
    });

    it('embeds the brand logo, resolved against the config file, as a data URI', () => {
        const read: string[] = [];
        const readFile = (file: string) => {
            read.push(file);
            return Buffer.from('png-bytes');
        };
        const contents = JSON.stringify({ ...productionConfig, brand: { logo: 'brand/logo.PNG' } });
        const { expo } = buildExpoConfig({ APP_ENV: 'production' }, {}, { configFile: { path: CONFIG_PATH, contents }, projectRoot: PROJECT_ROOT, readFile });
        expect(read).toEqual(['/repo/deploy/app-config/brand/logo.PNG']);
        expect(expo.extra.app.brand.logo).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
    });

    it('rejects a logo that is not a raster image, too large or unreadable', () => {
        expect(() => build({ ...productionConfig, brand: { logo: 'logo.svg' } })).toThrow(/brand\.logo: must be a \.png, \.jpg or \.webp image/);
        expect(() => build({ ...productionConfig, brand: { name: '' } })).toThrow(/brand\.name: must be a non-empty string/);
        const contents = JSON.stringify({ ...productionConfig, brand: { logo: 'logo.jpg' } });
        const options = (readFile: () => Buffer) => ({ configFile: { path: CONFIG_PATH, contents }, projectRoot: PROJECT_ROOT, readFile });
        expect(() => buildExpoConfig({ APP_ENV: 'production' }, {}, options(() => Buffer.alloc(256 * 1024 + 1)))).toThrow(/brand\.logo: .* the limit is 262144/);
        expect(() => buildExpoConfig({ APP_ENV: 'production' }, {}, options(() => { throw new Error('ENOENT'); }))).toThrow(/brand\.logo: cannot read .*logo\.jpg: ENOENT/);
    });

    it('rejects an unknown APP_ENV', () => {
        expect(() => buildExpoConfig({ APP_ENV: 'staging' })).toThrow(/Unknown APP_ENV "staging"/);
    });

    it('shrinks Android release builds', () => {
        const { expo } = buildExpoConfig({});
        const entry = expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-build-properties');
        expect(entry).toBeDefined();
        expect(entry[1].android).toMatchObject({
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            useLegacyPackaging: true,
        });
        expect(entry[1].android.extraProguardRules).toContain('-keep class com.margelo.nitro.** { *; }');
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

    it('requests no location or calendar access and loads no plugins for removed packages', () => {
        const { expo } = buildExpoConfig({});
        const pluginNames = expo.plugins.map((p: unknown) => (Array.isArray(p) ? p[0] : p)).filter((p: unknown) => typeof p === 'string');
        expect(pluginNames).not.toContain('expo-location');
        expect(pluginNames).not.toContain('expo-calendar');
        expect(JSON.stringify(expo)).not.toMatch(/location|calendar/i);
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
});
