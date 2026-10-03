import { describe, expect, it } from 'vitest';
import { linkDetail, resolveAppLink, resolveAppLinks } from './appLinks';

describe('resolveAppLink', () => {
    it('accepts https URLs', () => {
        expect(resolveAppLink(' https://example.com/issues ')).toBe('https://example.com/issues');
    });

    it('accepts http only for localhost', () => {
        expect(resolveAppLink('http://localhost:8080/help')).toBe('http://localhost:8080/help');
        expect(resolveAppLink('http://127.0.0.1/help')).toBe('http://127.0.0.1/help');
        expect(resolveAppLink('http://example.com/help')).toBeNull();
    });

    it('rejects blank, malformed and non-web values', () => {
        for (const raw of [undefined, null, 42, '', '   ', 'example.com/issues', 'javascript:alert(1)', 'mailto:help@example.com', 'ftp://example.com/']) {
            expect(resolveAppLink(raw)).toBeNull();
        }
    });
});

describe('resolveAppLinks', () => {
    it('resolves each link independently and hides the missing ones', () => {
        expect(resolveAppLinks({ issuesUrl: 'https://example.com/issues', privacyUrl: 'http://example.com/privacy' })).toEqual({
            githubUrl: null,
            issuesUrl: 'https://example.com/issues',
            privacyUrl: null,
            termsUrl: null,
            helpUrl: null,
        });
    });
});

describe('linkDetail', () => {
    it('shows owner/repo for GitHub and host plus path elsewhere', () => {
        expect(linkDetail('https://github.com/rophy/happy')).toBe('rophy/happy');
        expect(linkDetail('https://github.com/rophy/happy/')).toBe('rophy/happy');
        expect(linkDetail('https://git.example.com/team/happy')).toBe('git.example.com/team/happy');
    });
});
