export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * A custom PostHog host must be https, or http only for localhost (dev).
 * This never widens to allow a plain-http production host.
 */
function isValidPostHogHost(host: string): boolean {
    let url: URL;
    try {
        url = new URL(host);
    } catch {
        return false;
    }
    if (url.protocol === 'https:') {
        return true;
    }
    if (url.protocol === 'http:') {
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    }
    return false;
}

/**
 * PostHog runs only when the build sets EXPO_PUBLIC_POSTHOG_API_KEY.
 * EXPO_PUBLIC_POSTHOG_HOST selects a self-hosted instance.
 *
 * Fail-safe: a non-blank but invalid host disables analytics entirely rather
 * than silently falling back to the PostHog cloud default — a self-hosted
 * host was explicitly requested, and sending events to the public cloud
 * instead would be a silent data-destination change, not a safe default.
 */
export function resolvePostHogConfig(input: {
    apiKey?: string | null;
    host?: string | null;
    disabled?: boolean;
}): { apiKey: string; host: string } | null {
    const apiKey = input.apiKey?.trim();
    if (input.disabled || !apiKey) {
        return null;
    }
    const host = input.host?.trim().replace(/\/+$/, '');
    if (!host) {
        return { apiKey, host: DEFAULT_POSTHOG_HOST };
    }
    if (!isValidPostHogHost(host)) {
        return null;
    }
    return { apiKey, host };
}
