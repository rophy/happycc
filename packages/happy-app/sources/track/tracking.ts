import { config } from '@/config';
import PostHog from 'posthog-react-native';
import { resolvePostHogConfig } from './postHogConfig';

const postHog = resolvePostHogConfig({
    apiKey: config.postHogKey,
    host: config.postHogHost,
    disabled:
        process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === '1' ||
        process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === 'true' ||
        (globalThis as any).__HAPPY_CONFIG__?.disableAnalytics === true,
});

/** null unless the build configured PostHog; every caller must handle null. */
export const tracking = postHog ? new PostHog(postHog.apiKey, {
    host: postHog.host,
    captureAppLifecycleEvents: true,
}) : null;
