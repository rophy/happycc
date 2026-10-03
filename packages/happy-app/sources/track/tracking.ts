import { config } from '@/config';
import PostHog from 'posthog-react-native';
import { resolvePostHogConfig } from './postHogConfig';

const postHog = resolvePostHogConfig({
    apiKey: config.postHogKey,
    host: config.postHogHost,
    disabled: (globalThis as any).__HAPPY_CONFIG__?.disableAnalytics === true,
});

/** null unless the build configured PostHog; every caller must handle null. */
export const tracking = postHog ? new PostHog(postHog.apiKey, {
    host: postHog.host,
    captureAppLifecycleEvents: true,
}) : null;
