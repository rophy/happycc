import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ io: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.3' } } }));
vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ localSettings: { verboseLogging: false } }) } }));

import { apiSocket } from './apiSocket';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';
import type { AccessTokenProvider } from '@/auth/tokenStore';

function fakeSocket() {
    return { on: vi.fn(), onAny: vi.fn(), disconnect: vi.fn() };
}

afterEach(() => {
    apiSocket.disconnect();
    setAccessTokenProvider(null);
    vi.unstubAllGlobals();
    mocks.io.mockReset();
});

describe('apiSocket authentication', () => {
    it('asks for a fresh access token on every (re)connect', async () => {
        let current = 'token-1';
        const provider: AccessTokenProvider = {
            serverUrl: () => 'https://happy.test',
            getAccessToken: async () => current,
            refresh: async () => current,
        };
        setAccessTokenProvider(provider);
        mocks.io.mockReturnValue(fakeSocket());
        apiSocket.initialize({ endpoint: 'https://happy.test' }, {} as never);

        const options = mocks.io.mock.calls[0][1];
        expect(typeof options.auth).toBe('function');
        const first = await new Promise<any>((resolve) => options.auth(resolve));
        current = 'token-2';
        const second = await new Promise<any>((resolve) => options.auth(resolve));
        expect(first).toMatchObject({ token: 'token-1', clientType: 'user-scoped', happyClient: 'ios/1.2.3', appState: 'active' });
        expect(second.token).toBe('token-2');
    });

    it('sends REST requests through authFetch', async () => {
        setAccessTokenProvider(staticAccessTokenProvider('token-9', 'https://happy.test'));
        mocks.io.mockReturnValue(fakeSocket());
        apiSocket.initialize({ endpoint: 'https://happy.test' }, {} as never);
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await apiSocket.request('/v1/things', { method: 'POST', headers: { 'Content-Type': 'application/json' } });

        expect(fetchMock).toHaveBeenCalledWith('https://happy.test/v1/things', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                Authorization: 'Bearer token-9',
                'X-Happy-Client': 'ios/1.2.3',
                'Content-Type': 'application/json',
            }),
        }));
    });
});
