import { describe, expect, it } from 'vitest';
import { DEFAULT_POSTHOG_HOST, resolvePostHogConfig } from './postHogConfig';

describe('resolvePostHogConfig', () => {
    it('is off without an API key', () => {
        expect(resolvePostHogConfig({})).toBeNull();
        expect(resolvePostHogConfig({ apiKey: '   ', host: 'https://posthog.corp.example' })).toBeNull();
    });

    it('uses PostHog cloud when only the key is set', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test' })).toEqual({ apiKey: 'phc_test', host: DEFAULT_POSTHOG_HOST });
    });

    it('uses a self-hosted instance from the configured host', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test', host: 'https://posthog.corp.example/' }))
            .toEqual({ apiKey: 'phc_test', host: 'https://posthog.corp.example' });
    });

    it('stays off when analytics is disabled', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test', disabled: true })).toBeNull();
    });

    it('allows http for a localhost host', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test', host: 'http://localhost:8010' }))
            .toEqual({ apiKey: 'phc_test', host: 'http://localhost:8010' });
    });

    it('disables analytics for an invalid custom host instead of falling back to the default', () => {
        expect(resolvePostHogConfig({ apiKey: 'phc_test', host: 'not a url' })).toBeNull();
        expect(resolvePostHogConfig({ apiKey: 'phc_test', host: 'http://posthog.corp.example' })).toBeNull();
        expect(resolvePostHogConfig({ apiKey: 'phc_test', host: 'ftp://posthog.corp.example' })).toBeNull();
    });
});
