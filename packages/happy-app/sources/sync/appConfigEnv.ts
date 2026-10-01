import type { AppConfig } from './appConfig';

/**
 * EXPO_PUBLIC_* values the bundle was built with. Callers must pass literal
 * `process.env.EXPO_PUBLIC_X` reads: Metro only inlines literal accesses, so
 * `process.env` as a whole is empty on web.
 */
export type AppConfigEnv = {
    EXPO_PUBLIC_POSTHOG_API_KEY?: string;
    EXPO_PUBLIC_POSTHOG_HOST?: string;
    EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT?: string;
    EXPO_PUBLIC_SERVER_URL?: string;
};

function present(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** Native manifests are baked at prebuild; inlined EXPO_PUBLIC_* values win when set. */
export function applyAppConfigEnv(config: Partial<AppConfig>, env: AppConfigEnv): AppConfig {
    const result: Partial<AppConfig> = { ...config };
    const postHogKey = present(env.EXPO_PUBLIC_POSTHOG_API_KEY);
    if (postHogKey) {
        result.postHogKey = postHogKey;
    }
    const postHogHost = present(env.EXPO_PUBLIC_POSTHOG_HOST);
    if (postHogHost) {
        result.postHogHost = postHogHost;
    }
    const claudeConnect = present(env.EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT);
    if (claudeConnect !== undefined) {
        result.enableClaudeConnect = claudeConnect === '1';
    }
    const serverUrl = present(env.EXPO_PUBLIC_SERVER_URL);
    if (serverUrl) {
        result.serverUrl = serverUrl;
    }
    return result as AppConfig;
}
