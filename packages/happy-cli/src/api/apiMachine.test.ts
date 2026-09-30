import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import { LoggedOutError } from './tokenStore';
import type { Machine } from './types';

const {
    mockIo,
    mockShouldReconnect
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect,
    retainReconnectCapabilityMonitor: vi.fn(),
    releaseReconnectCapabilityMonitor: vi.fn()
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('reads the current token on every (re)connect', async () => {
        let current = 'token-1';
        const client = new ApiMachineClient(() => current, makeMachine());
        client.connect();

        const options = mockIo.mock.calls.at(-1)![1];
        expect(typeof options.auth).toBe('function');
        const first = await new Promise<any>((resolve) => options.auth(resolve));
        current = 'token-2';
        const second = await new Promise<any>((resolve) => options.auth(resolve));
        expect(first.token).toBe('token-1');
        expect(second.token).toBe('token-2');
        expect(second.clientType).toBe('machine-scoped');
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('rechecks reconnect eligibility before the delayed retry fires', async () => {
        vi.useFakeTimers();
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        mockShouldReconnect.mockReset();
        mockShouldReconnect.mockReturnValueOnce(true).mockReturnValue(false);
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).not.toHaveBeenCalled();

        client.shutdown();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('emits machine-alive immediately when the socket connects', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive')).toHaveLength(0);

        emitSocketEvent('connect');

        let aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);
        expect(aliveCalls[0][1]).toEqual(expect.objectContaining({
            machineId: 'test-machine-id',
            time: expect.any(Number)
        }));

        await vi.advanceTimersByTimeAsync(19999);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(2);

        client.shutdown();
    });

    it('reports readiness only after both spawn and resume are acknowledged, and resets on disconnect', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession: vi.fn(), resumeSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        client.connect();
        expect(client.isReady()).toBe(false);
        mockSocket.connected = true;
        emitSocketEvent('connect');
        emitSocketEvent('rpc-registered', { method: 'other:spawn-happy-session' });
        expect(client.isReady()).toBe(false);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:spawn-happy-session' });
        expect(client.isReady()).toBe(false);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:resume-happy-session' });
        expect(client.isReady()).toBe(true);
        emitSocketEvent('rpc-unregistered', { method: 'test-machine-id:resume-happy-session' });
        expect(client.isReady()).toBe(false);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:resume-happy-session' });
        emitSocketEvent('disconnect', 'transport close');
        expect(client.isReady()).toBe(false);
        emitSocketEvent('connect');
        expect(client.isReady()).toBe(false);
        client.shutdown();
    });

    it('does not require a resume acknowledgment when no resume handler exists', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        client.connect();
        mockSocket.connected = true;
        emitSocketEvent('connect');
        emitSocketEvent('rpc-registered', null);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:spawn-happy-session' });
        expect(client.isReady()).toBe(true);
        client.shutdown();
    });

    it('republishes the running CLI version without dropping stored machine fields', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const machine = makeMachine();
        machine.metadata.happyCliVersion = '1.0.0';
        const storedMetadata = machine.metadata as Machine['metadata'] & { displayName?: string };
        storedMetadata.displayName = 'My Mac';
        const client = new ApiMachineClient('fake-token', machine);
        let publishedMetadata: (Machine['metadata'] & { displayName?: string }) | null = null;
        vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async (handler) => {
            publishedMetadata = handler(storedMetadata);
        });
        client.connect();

        emitSocketEvent('connect');

        expect(publishedMetadata).toEqual(expect.objectContaining({
            displayName: 'My Mac',
            happyCliVersion: 'test',
            cliAvailability: expect.objectContaining({
                claude: false,
                codex: false,
            }),
        }));

        client.shutdown();
    });

    it('prefers the async getAccessToken getter over the sync token source, refreshing across a suspend', async () => {
        // Simulates a laptop suspend: wall-clock time has moved on (which is what
        // tokenStore.getAccessToken checks), but no timers have fired.
        const getAccessToken = vi.fn(async () => 'fresh-after-suspend');
        const client = new ApiMachineClient('stale-token', makeMachine(), getAccessToken);
        client.connect();

        const options = mockIo.mock.calls.at(-1)![1];
        const result = await new Promise<any>((resolve) => options.auth(resolve));

        expect(getAccessToken).toHaveBeenCalledTimes(1);
        expect(result.token).toBe('fresh-after-suspend');
        client.shutdown();
    });

    it('does not throw from the auth callback when getAccessToken rejects, and disconnects on LoggedOutError', async () => {
        vi.useFakeTimers();
        const getAccessToken = vi.fn(async () => { throw new LoggedOutError(); });
        const client = new ApiMachineClient('stale-token', makeMachine(), getAccessToken);
        client.connect();

        const options = mockIo.mock.calls.at(-1)![1];
        // The callback never calls cb() on a LoggedOutError (there is nothing
        // useful to hand the server); it must not throw or leave a hanging promise.
        expect(() => options.auth(() => { })).not.toThrow();
        await vi.waitFor(() => expect(mockSocket.close).toHaveBeenCalled());
    });

    it('does not throw from the auth callback on a non-logged-out rejection, and still calls cb', async () => {
        const getAccessToken = vi.fn(async () => { throw new Error('network blip'); });
        const client = new ApiMachineClient('stale-token', makeMachine(), getAccessToken);
        client.connect();

        const options = mockIo.mock.calls.at(-1)![1];
        let received: any;
        await new Promise<void>((resolve) => {
            expect(() => options.auth((data: any) => { received = data; resolve(); })).not.toThrow();
        });
        expect(received.token).toBe('');
        client.shutdown();
    });
});
