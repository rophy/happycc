import { describe, expect, it } from 'vitest';
import { parseLoopbackRedirectUri } from './loopbackRedirect';

describe('parseLoopbackRedirectUri', () => {
    it.each([
        'http://127.0.0.1:53682/callback',
        'http://[::1]:53682/callback',
        'http://127.0.0.1:1/callback',
        'http://127.0.0.1:80/callback',
        'http://127.0.0.1:65535/callback',
    ])('accepts %s unchanged', (uri) => {
        expect(parseLoopbackRedirectUri(uri)).toBe(uri);
    });

    it.each([
        undefined,
        '',
        'http://localhost:53682/callback',
        'http://127.0.0.2:53682/callback',
        'http://0.0.0.0:53682/callback',
        'http://[::2]:53682/callback',
        'http://[0:0:0:0:0:0:0:1]:53682/callback',
        'https://127.0.0.1:53682/callback',
        'HTTP://127.0.0.1:53682/callback',
        'http://127.0.0.1/callback',
        'http://127.0.0.1:0/callback',
        'http://127.0.0.1:00080/callback',
        'http://127.0.0.1:65536/callback',
        'http://127.0.0.1:99999/callback',
        'http://127.0.0.1:53682/',
        'http://127.0.0.1:53682/callback/',
        'http://127.0.0.1:53682/other',
        'http://127.0.0.1:53682/%63allback',
        'http://127.0.0.1:53682/callback?x=1',
        'http://127.0.0.1:53682/callback?',
        'http://127.0.0.1:53682/callback#frag',
        'http://user@127.0.0.1:53682/callback',
        ' http://127.0.0.1:53682/callback',
        'corpapp://auth/callback',
    ])('rejects %s', (uri) => {
        expect(parseLoopbackRedirectUri(uri)).toBeNull();
    });
});
