import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ clearPersistence: vi.fn(), replace: vi.fn() }));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({}));
vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: mocks.clearPersistence }));

import { dropLegacySessionAndReload } from './logout';
import { AUTH_KEY } from './tokenStorage';

let store: Map<string, string>;

beforeEach(() => {
    store = new Map();
    mocks.clearPersistence.mockReset();
    mocks.replace.mockReset();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
    });
    vi.stubGlobal('window', { location: { replace: mocks.replace } });
});

describe('dropLegacySessionAndReload', () => {
    it('drops pre-OIDC credentials with the old account\'s local data and restarts', async () => {
        store.set(AUTH_KEY, JSON.stringify({ token: 'legacy', secret: 'legacy-secret' }));
        await expect(dropLegacySessionAndReload()).resolves.toBe(true);
        expect(store.has(AUTH_KEY)).toBe(false);
        expect(mocks.clearPersistence).toHaveBeenCalledOnce();
        expect(mocks.replace).toHaveBeenCalledWith('/');
    });

    it('leaves current credentials and local data alone', async () => {
        const current = JSON.stringify({ token: 'access', refreshToken: 'refresh', secret: 'secret' });
        store.set(AUTH_KEY, current);
        await expect(dropLegacySessionAndReload()).resolves.toBe(false);
        expect(store.get(AUTH_KEY)).toBe(current);
        expect(mocks.clearPersistence).not.toHaveBeenCalled();
        expect(mocks.replace).not.toHaveBeenCalled();
    });

    it('does nothing when signed out', async () => {
        await expect(dropLegacySessionAndReload()).resolves.toBe(false);
        expect(mocks.clearPersistence).not.toHaveBeenCalled();
        expect(mocks.replace).not.toHaveBeenCalled();
    });
});
