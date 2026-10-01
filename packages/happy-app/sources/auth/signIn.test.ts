import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { scheme: 'happy-test' } } }));
vi.mock('expo-device', () => ({ modelName: 'Test' }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn() }));
// Never reached: signIn must refuse before creating a pending login.
vi.mock('expo-crypto', () => ({}));
vi.mock('@/encryption/libsodium.lib', () => ({ default: {} }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://happy.test' }));

import { signIn } from './signIn';
import { OidcLoginError } from './oidcLogin';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('signIn (web)', () => {
    it('refuses to start on a non-secure origin, without redirecting', async () => {
        const assign = vi.fn();
        const setItem = vi.fn();
        vi.stubGlobal('window', { isSecureContext: false, location: { assign }, sessionStorage: { setItem } });

        const error = await signIn().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(OidcLoginError);
        expect((error as Error).message).toBe('This web app must be served over HTTPS (or localhost).');
        expect(assign).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });
});
