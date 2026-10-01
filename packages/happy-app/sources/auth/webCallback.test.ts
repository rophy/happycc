import { afterEach, describe, expect, it, vi } from 'vitest';

function stubWindow(pathname: string, hash: string) {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
        location: { pathname, hash, search: '?x=1' },
        history: { state: { idx: 0 }, replaceState },
    });
    return replaceState;
}

async function load() {
    vi.resetModules();
    return import('./webCallback');
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('webCallback', () => {
    it('captures the #code on /auth/callback and strips the hash from the address bar', async () => {
        const replaceState = stubWindow('/auth/callback', '#code=abc');
        const { takeWebCallbackCode } = await load();
        expect(replaceState).toHaveBeenCalledWith({ idx: 0 }, '', '/auth/callback?x=1');
        expect(takeWebCallbackCode()).toBe('abc');
        expect(takeWebCallbackCode()).toBeNull();
    });

    it('accepts one trailing slash', async () => {
        const replaceState = stubWindow('/auth/callback/', '#code=def');
        const { takeWebCallbackCode } = await load();
        expect(replaceState).toHaveBeenCalledWith({ idx: 0 }, '', '/auth/callback/?x=1');
        expect(takeWebCallbackCode()).toBe('def');
    });

    it('ignores other paths', async () => {
        const replaceState = stubWindow('/settings', '#code=abc');
        const { takeWebCallbackCode } = await load();
        expect(replaceState).not.toHaveBeenCalled();
        expect(takeWebCallbackCode()).toBeNull();
    });

    it('does nothing without a window (native)', async () => {
        const { takeWebCallbackCode } = await load();
        expect(takeWebCallbackCode()).toBeNull();
    });
});
