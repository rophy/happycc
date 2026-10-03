/**
 * Builds the Expo config from APP_ENV and the organization's app config file
 * (APP_CONFIG, a JSON path). Pure apart from reading the brand logo through
 * options.readFile: app.config.js reads the file and passes its contents in;
 * sources/appConfig.test.ts passes fixtures.
 *
 * Every identity value is build-time configuration (spec §3 "Mobile builds").
 * Production refuses to build without its own identity; development and preview
 * fall back to placeholders under the reserved example.com namespace, never to
 * upstream identifiers.
 */
const fs = require('node:fs');
const path = require('node:path');

const VARIANTS = {
    development: { nameSuffix: ' (dev)', bundleId: 'com.example.happy.dev', scheme: 'happy-dev', consoleLoggingDefault: true },
    preview: { nameSuffix: ' (preview)', bundleId: 'com.example.happy.preview', scheme: 'happy-preview', consoleLoggingDefault: true },
    production: { nameSuffix: '', bundleId: null, scheme: null, consoleLoggingDefault: false },
};

/** Product names the app shows in place of the upstream ones (`brand` in the config). */
const DEFAULT_BRAND = { name: 'happycc', fullName: 'Happy Corporate Coder' };

/**
 * The brand logo is embedded in the manifest as a data URI, so native and web
 * get it from the same `extra` without a build-time copy into the bundle.
 * Hence raster formats React Native's Image decodes, and a size cap.
 */
const LOGO_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const LOGO_MAX_BYTES = 256 * 1024;

const PRODUCTION_REQUIRED = ['bundleId', 'scheme', 'serverUrl'];

/** The fork's source, shown in Settings unless the config sets `links.github` to null. */
const DEFAULT_GITHUB_URL = 'https://github.com/rophy/happycc';

/**
 * R8 keep rules for JNI-backed libraries that ship no consumer ProGuard rules
 * of their own. Their native code looks Java classes up by name, which R8
 * cannot see, so renaming or stripping them would crash only at runtime.
 */
const ANDROID_EXTRA_PROGUARD_RULES = [
    '-keep class com.margelo.nitro.** { *; }',
    '-keep class com.mrousavy.mmkv.** { *; }',
    '-keep class com.unistyles.** { *; }',
    '-keep class com.shopify.reactnative.skia.** { *; }',
    '-keep class com.libsodium.** { *; }',
    '-keep class com.reactnativequickbase64.** { *; }',
].join('\n');
const DEFAULT_ASSETS_DIR = './sources/assets/images';

function isLoopback(url) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function parseUrl(raw) {
    try {
        return new URL(raw);
    } catch {
        return null;
    }
}

/**
 * Value kinds of the config file. Each returns the normalized value or throws
 * a message; `ctx` carries the variant and the path helpers.
 */
const KINDS = {
    string: (v) => v,
    slug: (v) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) throw 'must be lowercase letters, digits and dashes';
        return v;
    },
    bundleId: (v) => {
        if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v)) throw 'must be a reverse-DNS id such as com.example.happy';
        return v;
    },
    scheme: (v) => {
        if (!/^[a-z][a-z0-9+.-]*$/.test(v)) throw 'must be a lowercase URL scheme such as acmehappy';
        return v;
    },
    host: (v) => {
        const label = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
        if (!new RegExp(`^${label}(?:\\.${label})*$`).test(v)) throw 'must be a bare host name such as happy.example.com';
        return v;
    },
    path: (v, ctx) => ctx.resolvePath(v),
    logo: (v, ctx) => {
        if (!LOGO_TYPES[path.extname(v).toLowerCase()]) throw 'must be a .png, .jpg or .webp image';
        return ctx.resolvePath(v);
    },
    // Plain http is for local and LAN servers; production allows it only for
    // localhost (the e2e web build), since iOS ATS blocks it elsewhere anyway.
    serverUrl: (v, ctx) => {
        const url = parseUrl(v);
        if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw 'must be an http:// or https:// URL';
        if (url.protocol === 'http:' && ctx.variant === 'production' && !isLoopback(url)) throw 'must be https:// in production (http://localhost only)';
        return url.href.replace(/\/+$/, '');
    },
    // Links the app opens (GitHub, issues, privacy, terms, help).
    link: (v, ctx) => {
        const url = parseUrl(v);
        if (url && url.protocol === 'https:') return url.href;
        if (url && url.protocol === 'http:' && isLoopback(url) && ctx.variant !== 'production') return url.href;
        throw 'must be an https:// URL (http://localhost only outside production)';
    },
    posthogHost: (v) => {
        const url = parseUrl(v);
        if (url && (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url)))) return url.href.replace(/\/+$/, '');
        throw 'must be an https:// URL (or http://localhost)';
    },
    // Dev tooling: the remote console log receiver (`pnpm app-logs`).
    logServerUrl: (v, ctx) => {
        if (ctx.variant === 'production') throw 'is dev tooling and not allowed in production builds';
        const url = parseUrl(v);
        if (url && (url.protocol === 'https:' || url.protocol === 'http:')) return url.href.replace(/\/+$/, '');
        throw 'must be an http:// or https:// URL';
    },
    mermaidScriptUrl: (v) => {
        const url = parseUrl(v);
        if (url && url.protocol === 'https:') return url.href;
        throw 'must be an https:// URL';
    },
};

/** The app config file schema. Nested objects are sections; strings name a kind. */
const APP_CONFIG_SCHEMA = {
    name: 'string',
    slug: 'slug',
    bundleId: 'bundleId',
    scheme: 'scheme',
    serverUrl: 'serverUrl',
    linksHost: 'host',
    eas: { projectId: 'string', owner: 'string' },
    googleServicesFile: 'path',
    assetsDir: 'path',
    links: { github: 'link', issues: 'link', privacy: 'link', terms: 'link', help: 'link' },
    analytics: { posthogKey: 'string', posthogHost: 'posthogHost' },
    features: { claudeConnect: 'boolean' },
    mermaidScriptUrl: 'mermaidScriptUrl',
    logServerUrl: 'logServerUrl',
    brand: { name: 'string', fullName: 'string', logo: 'logo' },
};

/** Keys that accept null, meaning "hide this". */
const NULLABLE = new Set(['links.github', 'links.issues', 'links.privacy', 'links.terms', 'links.help']);

function validateSection(input, schema, prefix, ctx, errors) {
    const out = {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        errors.push(`${prefix || '(root)'}: must be an object`);
        return out;
    }
    for (const [key, raw] of Object.entries(input)) {
        const name = prefix ? `${prefix}.${key}` : key;
        // Own keys only: `toString` or `__proto__` must not reach Object.prototype.
        const kind = Object.prototype.hasOwnProperty.call(schema, key) ? schema[key] : undefined;
        if (kind === undefined) {
            errors.push(`${name}: unknown key`);
            continue;
        }
        if (typeof kind === 'object') {
            out[key] = validateSection(raw, kind, name, ctx, errors);
            continue;
        }
        if (raw === null && NULLABLE.has(name)) {
            out[key] = null;
            continue;
        }
        if (kind === 'boolean') {
            if (typeof raw !== 'boolean') errors.push(`${name}: must be true or false`);
            else out[key] = raw;
            continue;
        }
        if (typeof raw !== 'string' || !raw.trim()) {
            errors.push(`${name}: must be a non-empty string`);
            continue;
        }
        try {
            out[key] = KINDS[kind](raw.trim(), ctx);
        } catch (message) {
            errors.push(`${name}: ${message}`);
        }
    }
    return out;
}

/**
 * Parses and strictly validates the app config file. Relative paths in it
 * resolve against the file's directory and come back relative to the app's
 * project root, the way Expo expects them.
 */
function parseAppConfig(file, variant, projectRoot) {
    if (!file) {
        return {};
    }
    let json;
    try {
        json = JSON.parse(file.contents);
    } catch (e) {
        throw new Error(`APP_CONFIG ${file.path} is not valid JSON: ${e.message}`);
    }
    const configDir = path.dirname(file.path);
    const ctx = {
        variant,
        resolvePath: (p) => {
            const relative = path.relative(projectRoot, path.resolve(configDir, p)).split(path.sep).join('/');
            return relative.startsWith('.') || path.isAbsolute(relative) ? relative : `./${relative}`;
        },
    };
    const errors = [];
    const config = validateSection(json, APP_CONFIG_SCHEMA, '', ctx, errors);
    if (errors.length > 0) {
        throw new Error(`Invalid APP_CONFIG ${file.path}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    }
    return config;
}

function envValue(env, name) {
    const raw = env[name];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Reads the brand logo (a path relative to the project root) into a data URI. */
function logoDataUri(logo, projectRoot, readFile) {
    const file = path.resolve(projectRoot, logo);
    let bytes;
    try {
        bytes = readFile(file);
    } catch (e) {
        throw new Error(`APP_CONFIG brand.logo: cannot read ${file}: ${e.message}`);
    }
    if (bytes.length > LOGO_MAX_BYTES) {
        throw new Error(`APP_CONFIG brand.logo: ${file} is ${bytes.length} bytes; the limit is ${LOGO_MAX_BYTES}`);
    }
    return `data:${LOGO_TYPES[path.extname(file).toLowerCase()]};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * @param env process environment; only APP_ENV is read.
 * @param buildMetadata git commit info for the Settings version row.
 * @param options.configFile `{ path, contents }` of the APP_CONFIG file, or null.
 * @param options.projectRoot directory app.config.js lives in (defaults to this file's).
 * @param options.readFile reads the brand logo (defaults to fs.readFileSync).
 */
function buildExpoConfig(env, buildMetadata = {}, options = {}) {
    const variant = envValue(env, 'APP_ENV') || 'development';
    const defaults = VARIANTS[variant];
    if (!defaults) {
        throw new Error(`Unknown APP_ENV "${variant}". Use development, preview or production.`);
    }
    const projectRoot = options.projectRoot || __dirname;
    const cfg = parseAppConfig(options.configFile || null, variant, projectRoot);
    if (variant === 'production') {
        if (!options.configFile) {
            throw new Error('Production builds require APP_CONFIG, the path of your organization\'s app config JSON. There is no fallback to upstream identifiers.');
        }
        const missing = PRODUCTION_REQUIRED.filter((key) => cfg[key] === undefined);
        if (missing.length > 0) {
            throw new Error(`Production builds require ${missing.join(', ')} in APP_CONFIG ${options.configFile.path}. Set them to your organization's values; there is no fallback to upstream identifiers.`);
        }
    }

    const brand = { ...DEFAULT_BRAND, ...cfg.brand };
    const name = cfg.name || `${brand.name}${defaults.nameSuffix}`;
    const slug = cfg.slug || 'happy';
    const bundleId = cfg.bundleId || defaults.bundleId;
    const scheme = cfg.scheme || defaults.scheme;
    const linksHost = cfg.linksHost;
    const easProjectId = cfg.eas?.projectId;
    const easOwner = cfg.eas?.owner;
    const googleServicesFile = cfg.googleServicesFile;
    const assetsDir = (cfg.assetsDir || DEFAULT_ASSETS_DIR).replace(/\/+$/, '');
    const asset = (file) => `${assetsDir}/${file}`;
    const links = cfg.links || {};

    const expo = {
        name,
        slug,
        version: '1.8.0',
        runtimeVersion: '21',
        orientation: 'default',
        icon: asset('icon.png'),
        scheme,
        userInterfaceStyle: 'automatic',
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false,
            },
            infoPlist: {
                NSLocalNetworkUsageDescription: 'Allow $(PRODUCT_NAME) to find and connect to local devices on your network.',
                NSBonjourServices: ['_http._tcp', '_https._tcp'],
                // ATS: NSAllowsLocalNetworking lets HTTP reach LAN addresses; dev/preview
                // also allow arbitrary HTTP loads for a developer's own server.
                NSAppTransportSecurity: variant === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true },
            },
            ...(linksHost ? { associatedDomains: [`applinks:${linksHost}`] } : {}),
        },
        android: {
            adaptiveIcon: {
                foregroundImage: asset('icon-adaptive.png'),
                monochromeImage: asset('icon-monochrome.png'),
                backgroundColor: '#000000',
            },
            permissions: [
                'android.permission.ACCESS_NETWORK_STATE',
                'android.permission.POST_NOTIFICATIONS',
            ],
            blockedPermissions: [
                'android.permission.ACTIVITY_RECOGNITION',
                // Not using external storage/media access — blocks Google Play photo/video permission declaration
                'android.permission.READ_EXTERNAL_STORAGE',
                'android.permission.WRITE_EXTERNAL_STORAGE',
                'android.permission.READ_MEDIA_IMAGES',
                'android.permission.READ_MEDIA_VIDEO',
            ],
            package: bundleId,
            ...(googleServicesFile ? { googleServicesFile } : {}),
            intentFilters: linksHost ? [
                {
                    action: 'VIEW',
                    autoVerify: true,
                    data: [{ scheme: 'https', host: linksHost, pathPrefix: '/' }],
                    category: ['BROWSABLE', 'DEFAULT'],
                },
            ] : [],
        },
        web: {
            bundler: 'metro',
            output: 'single',
            favicon: asset('favicon.png'),
        },
        plugins: [
            require('./plugins/withEinkCompatibility.js'),
            ['expo-build-properties', {
                android: {
                    // Release APK size: R8 shrinks code, resources drop what it
                    // leaves unreferenced, and native libs are stored compressed.
                    enableMinifyInReleaseBuilds: true,
                    enableShrinkResourcesInReleaseBuilds: true,
                    useLegacyPackaging: true,
                    extraProguardRules: ANDROID_EXTRA_PROGUARD_RULES,
                },
            }],
            ['expo-router', { root: './sources/app' }],
            'expo-updates',
            'expo-asset',
            'expo-localization',
            'expo-mail-composer',
            'expo-secure-store',
            'expo-web-browser',
            '@more-tech/react-native-libsodium',
            // The picker only reads the photo library. Without this entry Expo
            // applies its plugin with defaults, which adds camera and microphone
            // usage strings and RECORD_AUDIO; `false` removes and blocks them.
            ['expo-image-picker', {
                cameraPermission: false,
                microphonePermission: false,
            }],
            ['expo-notifications', {
                enableBackgroundRemoteNotifications: true,
                icon: asset('icon-notification.png'),
            }],
            ['expo-splash-screen', {
                ios: {
                    backgroundColor: '#F2F2F7',
                    dark: { backgroundColor: '#000000' },
                },
                android: {
                    image: asset('splash-android-light.png'),
                    backgroundColor: '#F5F5F5',
                    dark: {
                        image: asset('splash-android-dark.png'),
                        backgroundColor: '#000000',
                    },
                },
            }],
        ],
        ...(easProjectId ? {
            updates: {
                url: `https://u.expo.dev/${easProjectId}`,
                requestHeaders: { 'expo-channel-name': 'production' },
            },
        } : {}),
        experiments: {
            typedRoutes: true,
        },
        extra: {
            router: { root: './sources/app' },
            ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
            app: {
                serverUrl: cfg.serverUrl,
                postHogKey: cfg.analytics?.posthogKey,
                postHogHost: cfg.analytics?.posthogHost,
                enableClaudeConnect: cfg.features?.claudeConnect === true,
                mermaidScriptUrl: cfg.mermaidScriptUrl,
                consoleLoggingDefault: defaults.consoleLoggingDefault,
                githubUrl: links.github === undefined ? DEFAULT_GITHUB_URL : links.github ?? undefined,
                issuesUrl: links.issues ?? undefined,
                privacyUrl: links.privacy ?? undefined,
                termsUrl: links.terms ?? undefined,
                helpUrl: links.help ?? undefined,
                logServerUrl: cfg.logServerUrl,
                brand: {
                    name: brand.name,
                    fullName: brand.fullName,
                    ...(brand.logo ? { logo: logoDataUri(brand.logo, projectRoot, options.readFile || fs.readFileSync) } : {}),
                },
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            },
        },
        ...(easOwner ? { owner: easOwner } : {}),
    };
    return { expo };
}

module.exports = { buildExpoConfig, parseAppConfig, APP_CONFIG_SCHEMA, VARIANTS, PRODUCTION_REQUIRED };
