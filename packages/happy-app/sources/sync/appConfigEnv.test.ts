import { describe, expect, it } from 'vitest';
import { applyAppConfigEnv } from './appConfigEnv';

describe('applyAppConfigEnv', () => {
    it('keeps the manifest values when nothing is set', () => {
        expect(applyAppConfigEnv({ postHogKey: 'phc_manifest', enableClaudeConnect: false }, {}))
            .toEqual({ postHogKey: 'phc_manifest', enableClaudeConnect: false });
    });

    it('overrides from EXPO_PUBLIC_* values and ignores blanks', () => {
        const config = applyAppConfigEnv({}, {
            EXPO_PUBLIC_POSTHOG_API_KEY: ' phc_env ',
            EXPO_PUBLIC_POSTHOG_HOST: 'https://posthog.corp.example',
            EXPO_PUBLIC_SERVER_URL: '  ',
        });
        expect(config).toEqual({ postHogKey: 'phc_env', postHogHost: 'https://posthog.corp.example' });
    });

    it('enables Claude connect only for "1"', () => {
        expect(applyAppConfigEnv({}, { EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: '1' }).enableClaudeConnect).toBe(true);
        expect(applyAppConfigEnv({ enableClaudeConnect: true }, { EXPO_PUBLIC_ENABLE_CLAUDE_CONNECT: 'true' }).enableClaudeConnect).toBe(false);
        expect(applyAppConfigEnv({}, {}).enableClaudeConnect).toBeUndefined();
    });

    it('accepts an https mermaid script URL and rejects http/blank', () => {
        expect(applyAppConfigEnv({}, { EXPO_PUBLIC_MERMAID_SCRIPT_URL: 'https://corp.example/mermaid.min.js' }).mermaidScriptUrl)
            .toBe('https://corp.example/mermaid.min.js');
        expect(applyAppConfigEnv({}, { EXPO_PUBLIC_MERMAID_SCRIPT_URL: 'http://corp.example/mermaid.min.js' }).mermaidScriptUrl)
            .toBeUndefined();
        expect(applyAppConfigEnv({}, {}).mermaidScriptUrl).toBeUndefined();
    });
});
