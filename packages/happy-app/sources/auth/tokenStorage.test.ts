import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({}));

import { AUTH_KEY, TokenStorage } from './tokenStorage';

let store: Map<string, string>;
let throwOnSet = false;

beforeEach(() => {
    store = new Map();
    throwOnSet = false;
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            if (throwOnSet) throw new Error('QuotaExceededError');
            store.set(key, String(value));
        },
        removeItem: (key: string) => { store.delete(key); },
    });
});

const creds = { token: 'access-1', refreshToken: 'refresh-1', secret: 'secret-1' };

describe('TokenStorage (web)', () => {
    it('round-trips credentials', async () => {
        await expect(TokenStorage.setCredentials(creds)).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toEqual(creds);
    });

    it('treats pre-OIDC credentials as logged out and removes them', async () => {
        store.set(AUTH_KEY, JSON.stringify({ token: 'legacy', secret: 'legacy-secret' }));
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        expect(store.has(AUTH_KEY)).toBe(false);
    });

    it('removes credentials only when they still hold the given refresh token', async () => {
        await TokenStorage.setCredentials(creds);
        await TokenStorage.removeCredentialsIfRefreshToken('other');
        expect(store.has(AUTH_KEY)).toBe(true);
        await TokenStorage.removeCredentialsIfRefreshToken('refresh-1');
        expect(store.has(AUTH_KEY)).toBe(false);
    });

    it('reports a failed write', async () => {
        throwOnSet = true;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(TokenStorage.setCredentials(creds)).resolves.toBe(false);
        expect(consoleError).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });
});
