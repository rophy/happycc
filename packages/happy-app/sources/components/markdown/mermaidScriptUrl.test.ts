import { describe, expect, it } from 'vitest';
import { resolveMermaidScriptUrl } from './mermaidScriptUrl';

describe('resolveMermaidScriptUrl', () => {
    it('returns null when unset', () => {
        expect(resolveMermaidScriptUrl(undefined)).toBeNull();
        expect(resolveMermaidScriptUrl(null)).toBeNull();
        expect(resolveMermaidScriptUrl('')).toBeNull();
        expect(resolveMermaidScriptUrl('   ')).toBeNull();
    });

    it('accepts an https URL', () => {
        expect(resolveMermaidScriptUrl('https://example.com/mermaid@11.3.0/mermaid.min.js'))
            .toBe('https://example.com/mermaid@11.3.0/mermaid.min.js');
    });

    it('trims surrounding whitespace', () => {
        expect(resolveMermaidScriptUrl('  https://example.com/mermaid.min.js  '))
            .toBe('https://example.com/mermaid.min.js');
    });

    it('rejects an http URL', () => {
        expect(resolveMermaidScriptUrl('http://example.com/mermaid.min.js')).toBeNull();
    });

    it('rejects a non-URL value', () => {
        expect(resolveMermaidScriptUrl('not a url')).toBeNull();
    });

    it('rejects a public CDN masquerading as unset guard bypass but still validates protocol only', () => {
        // Still accepted if https — the helper only enforces scheme, not allow-listed hosts.
        expect(resolveMermaidScriptUrl('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'))
            .toBe('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js');
    });
});
