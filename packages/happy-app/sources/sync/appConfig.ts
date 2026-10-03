import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { resolveMermaidScriptUrl } from '../components/markdown/mermaidScriptUrl';

export interface AppConfig {
    postHogKey?: string;
    postHogHost?: string;
    enableClaudeConnect?: boolean;
    consoleLoggingDefault?: boolean;
    serverUrl?: string;
    buildCommitSha?: string;
    buildCommitTimestamp?: string;
    mermaidScriptUrl?: string;
    githubUrl?: string;
    issuesUrl?: string;
    privacyUrl?: string;
    termsUrl?: string;
    helpUrl?: string;
    logServerUrl?: string;
}

/**
 * Loads app configuration from various manifest sources.
 * Looks for the "app" field in expoConfig.extra across different manifests
 * and merges them into a single configuration object.
 * 
 * Every value comes from the build's APP_CONFIG file via expoConfig.cjs; web
 * gets the same manifest, inlined when the bundle is built.
 *
 * Priority (later overrides earlier):
 * 1. ExponentConstants native module manifest (fetches embedded manifest)
 * 2. Constants.expoConfig
 */
export function loadAppConfig(): AppConfig {
    const config: Partial<AppConfig> = {};

    try {
        // 1. Try ExponentConstants native module directly
        const ExponentConstants = requireOptionalNativeModule('ExponentConstants');
        if (ExponentConstants && ExponentConstants.manifest) {
            let exponentManifest = ExponentConstants.manifest;

            // On Android, manifest is passed as JSON string
            if (typeof exponentManifest === 'string') {
                try {
                    exponentManifest = JSON.parse(exponentManifest);
                } catch (e) {
                    console.warn('[loadAppConfig] Failed to parse ExponentConstants.manifest:', e);
                }
            }

            // Look for app config in various locations
            const appConfig = exponentManifest?.extra?.app;
            if (appConfig && typeof appConfig === 'object') {
                Object.assign(config, appConfig);
                console.log('[loadAppConfig] Loaded from ExponentConstants:', Object.keys(config));
            }
        }
    } catch (e) {
        console.warn('[loadAppConfig] Error accessing ExponentConstants:', e);
    }

    try {
        // 2. Try Constants.expoConfig
        if (Constants.expoConfig?.extra?.app) {
            const appConfig = Constants.expoConfig.extra.app;
            if (typeof appConfig === 'object') {
                Object.assign(config, appConfig);
                console.log('[loadAppConfig] Loaded from Constants.expoConfig:', Object.keys(config));
            }
        }
    } catch (e) {
        console.warn('[loadAppConfig] Error accessing Constants.expoConfig:', e);
    }

    console.log('[loadAppConfig] Final merged config:', JSON.stringify(config, null, 2));

    // Validated at build time; re-checked here because the value is
    // interpolated into the native renderer's WebView HTML.
    return { ...config, mermaidScriptUrl: resolveMermaidScriptUrl(config.mermaidScriptUrl) ?? undefined } as AppConfig;
}
