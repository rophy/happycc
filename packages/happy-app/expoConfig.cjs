/**
 * Builds the Expo config from environment variables. Pure: app.config.js passes
 * process.env and git metadata; sources/appConfig.test.ts passes fixtures.
 *
 * Every identity value is build-time configuration (spec §3 "Mobile builds").
 * Production refuses to build without its own identity; development and preview
 * fall back to placeholders under the reserved example.com namespace, never to
 * upstream identifiers.
 */
const VARIANTS = {
    development: { name: 'Happy (dev)', bundleId: 'com.example.happy.dev', scheme: 'happy-dev', consoleLoggingDefault: true },
    preview: { name: 'Happy (preview)', bundleId: 'com.example.happy.preview', scheme: 'happy-preview', consoleLoggingDefault: true },
    production: { name: 'Happy', bundleId: null, scheme: null, consoleLoggingDefault: false },
};

const PRODUCTION_REQUIRED = ['APP_BUNDLE_ID', 'APP_SCHEME', 'HAPPY_SERVER_URL'];
const DEFAULT_ASSETS_DIR = './sources/assets/images';

function value(env, name) {
    const raw = env[name];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function buildExpoConfig(env, buildMetadata = {}) {
    const variant = value(env, 'APP_ENV') || 'development';
    const defaults = VARIANTS[variant];
    if (!defaults) {
        throw new Error(`Unknown APP_ENV "${variant}". Use development, preview or production.`);
    }
    if (variant === 'production') {
        const missing = PRODUCTION_REQUIRED.filter((name) => !value(env, name));
        if (missing.length > 0) {
            throw new Error(`Production builds require ${missing.join(', ')}. Set them to your organization's values; there is no fallback to upstream identifiers.`);
        }
    }

    const name = value(env, 'APP_NAME') || defaults.name;
    const slug = value(env, 'APP_SLUG') || 'happy';
    const bundleId = value(env, 'APP_BUNDLE_ID') || defaults.bundleId;
    const scheme = value(env, 'APP_SCHEME') || defaults.scheme;
    const linksHost = value(env, 'APP_LINKS_HOST');
    const easProjectId = value(env, 'EAS_PROJECT_ID');
    const easOwner = value(env, 'EAS_OWNER');
    const googleServicesFile = value(env, 'GOOGLE_SERVICES_FILE');
    const assetsDir = (value(env, 'APP_ASSETS_DIR') || DEFAULT_ASSETS_DIR).replace(/\/+$/, '');
    const asset = (file) => `${assetsDir}/${file}`;

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
                NSMicrophoneUsageDescription: 'Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.',
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
                'android.permission.RECORD_AUDIO',
                'android.permission.MODIFY_AUDIO_SETTINGS',
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
            ['expo-router', { root: './sources/app' }],
            'expo-updates',
            'expo-asset',
            'expo-localization',
            'expo-mail-composer',
            'expo-secure-store',
            'expo-web-browser',
            'react-native-vision-camera',
            '@more-tech/react-native-libsodium',
            'react-native-audio-api',
            '@livekit/react-native-expo-plugin',
            '@config-plugins/react-native-webrtc',
            ['expo-audio', {
                microphonePermission: 'Allow $(PRODUCT_NAME) to access your microphone for voice conversations.',
            }],
            ['expo-location', {
                locationAlwaysAndWhenInUsePermission: 'Allow $(PRODUCT_NAME) to improve AI quality by using your location.',
                locationAlwaysPermission: 'Allow $(PRODUCT_NAME) to improve AI quality by using your location.',
                locationWhenInUsePermission: 'Allow $(PRODUCT_NAME) to improve AI quality by using your location.',
            }],
            ['expo-calendar', {
                calendarPermission: 'Allow $(PRODUCT_NAME) to access your calendar to improve AI quality.',
            }],
            ['expo-camera', {
                cameraPermission: 'Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.',
                microphonePermission: 'Allow $(PRODUCT_NAME) to access your microphone for voice conversations.',
                recordAudioAndroid: true,
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
                postHogKey: value(env, 'EXPO_PUBLIC_POSTHOG_API_KEY') || undefined,
                postHogHost: value(env, 'EXPO_PUBLIC_POSTHOG_HOST') || undefined,
                enableClaudeConnect: value(env, 'EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT') === '1',
                consoleLoggingDefault: defaults.consoleLoggingDefault,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
            },
        },
        ...(easOwner ? { owner: easOwner } : {}),
    };
    return { expo };
}

module.exports = { buildExpoConfig, VARIANTS, PRODUCTION_REQUIRED };
