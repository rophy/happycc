import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ io: vi.fn() }));

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.3' } } }));
vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ localSettings: { verboseLogging: false } }) } }));

import { apiSocket, reconnectDelayMs } from './apiSocket';
import { setAccessTokenProvider, staticAccessTokenProvider } from '@/auth/authFetch';
import { LoggedOutError, type AccessTokenProvider } from '@/auth/tokenStore';

function fakeSocket() {
    return { on: vi.fn(), onAny: vi.fn(), disconnect: vi.fn() };
}

/** A socket whose events the test fires; `active` mirrors socket.io's "will reconnect on its own". */
function controllableSocket() {
    const handlers = new Map<string, (...args: any[]) => void>();
    const socket = {
        active: true,
        connected: false,
        recovered: false,
        on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers.set(event, handler); }),
        onAny: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(() => { socket.active = true; }),
        fire(event: string, ...args: any[]) { handlers.get(event)!(...args); },
    };
    return socket;
}

afterEach(() => {
    apiSocket.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

describe('apiSocket reconnect after the server gives up on the socket', () => {
    function start() {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(1); // no jitter: 1 s, 2 s, 4 s ...
        setAccessTokenProvider(staticAccessTokenProvider('token-1', 'https://happy.test'));
        const socket = controllableSocket();
        mocks.io.mockReturnValue(socket);
        apiSocket.initialize({ endpoint: 'https://happy.test' }, {} as never);
        return socket;
    }

    function serverDisconnect(socket: ReturnType<typeof controllableSocket>) {
        socket.active = false;
        socket.fire('disconnect', 'io server disconnect');
    }

    function handshakeRejected(socket: ReturnType<typeof controllableSocket>) {
        socket.active = false;
        socket.fire('connect_error', new Error('Invalid authentication token'));
    }

    it('reconnects after an io server disconnect', () => {
        const socket = start();
        serverDisconnect(socket);
        vi.advanceTimersByTime(999);
        expect(socket.connect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(socket.connect).toHaveBeenCalledOnce();
        expect(mocks.io).toHaveBeenCalledOnce();
    });

    it('does not reconnect manually after a client or transport disconnect', () => {
        const socket = start();
        socket.fire('disconnect', 'transport close'); // socket.io reconnects on its own
        vi.advanceTimersByTime(60_000);
        expect(socket.connect).not.toHaveBeenCalled();
    });

    it('retries a rejected handshake with exponential backoff capped at 30 s, reset on connect', () => {
        const socket = start();
        const delays: number[] = [];
        for (let i = 0; i < 7; i++) {
            handshakeRejected(socket);
            let waited = 0;
            const before = socket.connect.mock.calls.length;
            while (socket.connect.mock.calls.length === before && waited < 60_000) {
                vi.advanceTimersByTime(500);
                waited += 500;
            }
            delays.push(waited);
        }
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

        socket.connected = true;
        socket.fire('connect');
        socket.connected = false;
        handshakeRejected(socket);
        vi.advanceTimersByTime(1_000);
        expect(socket.connect).toHaveBeenCalledTimes(8);
    });

    it('leaves a connect_error to socket.io while it is still reconnecting itself', () => {
        const socket = start();
        socket.fire('connect_error', new Error('websocket error')); // active stays true
        vi.advanceTimersByTime(60_000);
        expect(socket.connect).not.toHaveBeenCalled();
    });

    it('stops reconnecting when the app disconnects', () => {
        const socket = start();
        serverDisconnect(socket);
        apiSocket.disconnect();
        vi.advanceTimersByTime(60_000);
        expect(socket.connect).not.toHaveBeenCalled();
    });

    it('stops reconnecting once signed out', async () => {
        vi.useFakeTimers();
        setAccessTokenProvider({
            serverUrl: () => 'https://happy.test',
            getAccessToken: async () => { throw new LoggedOutError(); },
            refresh: async () => { throw new LoggedOutError(); },
        });
        const socket = controllableSocket();
        mocks.io.mockReturnValue(socket);
        apiSocket.initialize({ endpoint: 'https://happy.test' }, {} as never);
        serverDisconnect(socket);
        vi.advanceTimersByTime(1_000);
        expect(socket.connect).toHaveBeenCalledOnce();

        // The retry's handshake asks for a token and learns the session is gone.
        const cb = vi.fn();
        mocks.io.mock.calls[0][1].auth(cb);
        await vi.advanceTimersByTimeAsync(0);
        expect(cb).not.toHaveBeenCalled();
        expect(socket.disconnect).toHaveBeenCalledOnce();

        handshakeRejected(socket);
        vi.advanceTimersByTime(60_000);
        expect(socket.connect).toHaveBeenCalledOnce();
    });

    it('jitters each delay down by at most half', () => {
        expect(reconnectDelayMs(0, 0)).toBe(500);
        expect(reconnectDelayMs(0, 1)).toBe(1_000);
        expect(reconnectDelayMs(10, 0)).toBe(15_000);
        expect(reconnectDelayMs(10, 1)).toBe(30_000);
    });
});
