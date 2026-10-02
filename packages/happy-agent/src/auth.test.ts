import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { readCredentials, writeCredentials } from './credentials';
import * as credentialsModule from './credentials';
import { encodeBase64, getRandomBytes } from './encryption';
import { makeJwt, startFakeServer } from './testing/fakeServer';

vi.mock('./loopbackLogin', () => ({
    loopbackLogin: vi.fn(async (opts: { io: { print(line: string): void; onUrl?(url: string): void | Promise<void> } }) => {
        await opts.io.onUrl?.('https://idp.example.test/login?loginUrl=1');
        return { token: 'access-token', refreshToken: 'refresh-token', secret: new Uint8Array(32) };
    }),
}));

// `open` must never actually launch a browser in tests; it is always mocked.
// The real package resolves with the spawned child process, so the mock
// returns an EventEmitter (a ChildProcess stand-in) to exercise the
// 'error' handling in auth.ts.
vi.mock('open', () => ({ default: vi.fn(async () => new EventEmitter()) }));

import open from 'open';
import { loopbackLogin } from './loopbackLogin';
import { authLogin, authLogout, authStatus } from './auth';

/** authLogin only attempts to open a browser in a TTY, non-CI, non-headless session. */
function forceInteractiveTty(): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const { CI, HEADLESS } = process.env;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.CI;
    delete process.env.HEADLESS;
    return () => {
        if (descriptor) {
            Object.defineProperty(process.stdout, 'isTTY', descriptor);
        } else {
            delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
        if (CI !== undefined) process.env.CI = CI;
        if (HEADLESS !== undefined) process.env.HEADLESS = HEADLESS;
    };
}

let homeDir: string;
let server: Awaited<ReturnType<typeof startFakeServer>> | null = null;
let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-auth-'));
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
});
afterEach(async () => {
    logSpy.mockRestore();
    vi.mocked(loopbackLogin).mockClear();
    vi.mocked(open).mockClear();
    await server?.close();
    server = null;
    rmSync(homeDir, { recursive: true, force: true });
});

function configFor(serverUrl = 'http://127.0.0.1:9'): Config {
    return { serverUrl, homeDir, credentialPath: join(homeDir, 'agent.key') };
}

describe('authLogin', () => {
    it('signs in as happyco-agent@<host> and reports success without printing tokens', async () => {
        const config = configFor();
        await authLogin(config);
        const call = vi.mocked(loopbackLogin).mock.calls[0][0];
        expect(call.config).toBe(config);
        expect(call.deviceName).toMatch(/^happyco-agent@.+/);
        expect(logs).toContain('- Status: Authenticated');
        expect(logs.join('\n')).not.toContain('access-token');
    });

    it('opens the browser with the login URL by default in an interactive session', async () => {
        const restore = forceInteractiveTty();
        try {
            await authLogin(configFor());
            expect(vi.mocked(open)).toHaveBeenCalledWith('https://idp.example.test/login?loginUrl=1');
        } finally {
            restore();
        }
    });

    it('does not open the browser when openBrowser is false (--no-browser)', async () => {
        const restore = forceInteractiveTty();
        try {
            await authLogin(configFor(), { openBrowser: false });
            expect(vi.mocked(open)).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });

    it('does not attempt to open a browser outside an interactive TTY', async () => {
        await authLogin(configFor());
        expect(vi.mocked(open)).not.toHaveBeenCalled();
    });

    it('does not attempt to open a browser when CI is set, even in a TTY', async () => {
        const restore = forceInteractiveTty();
        try {
            process.env.CI = 'true';
            await authLogin(configFor());
            expect(vi.mocked(open)).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });

    it('keeps going quietly and still signs in when opening the browser fails to spawn', async () => {
        const restore = forceInteractiveTty();
        try {
            vi.mocked(open).mockRejectedValueOnce(new Error('no display'));
            await expect(authLogin(configFor())).resolves.toBeUndefined();
            expect(logs).toContain('- Status: Authenticated');
        } finally {
            restore();
        }
    });

    it('keeps waiting and still completes when the spawned browser process errors asynchronously', async () => {
        const restore = forceInteractiveTty();
        try {
            const child = new EventEmitter();
            vi.mocked(open).mockImplementationOnce(async () => {
                // Simulate a real failed spawn (e.g. missing xdg-open): the
                // 'error' event fires after open() has already resolved.
                setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
                return child as unknown as Awaited<ReturnType<typeof open>>;
            });
            await expect(authLogin(configFor())).resolves.toBeUndefined();
            expect(logs).toContain('- Status: Authenticated');
            // The emitted 'error' must have had a listener — otherwise node
            // would have thrown and this test would fail with an unhandled error.
            expect(child.listenerCount('error')).toBeGreaterThan(0);
        } finally {
            restore();
        }
    });
});

describe('authLogout', () => {
    it('revokes the device on the server, then deletes the credentials', async () => {
        server = await startFakeServer({ 'POST /v1/auth/logout': () => ({ status: 200, body: { success: true } }) });
        const config = configFor(server.url);
        const token = makeJwt(900);
        writeCredentials(config, { token, refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(server.calls.map((c) => [c.path, c.authorization])).toEqual([['/v1/auth/logout', `Bearer ${token}`]]);
        expect(existsSync(config.credentialPath)).toBe(false);
        expect(existsSync(`${config.credentialPath}.lock`)).toBe(false);
        expect(logs).toContain('- Status: Logged out');
        expect(logs).toContain('- Server session: Revoked');
        expect(logs).toContain('- Credentials: Cleared');
    });

    it('still deletes the credentials when the server is unreachable', async () => {
        const config = configFor('http://127.0.0.1:9');
        writeCredentials(config, { token: makeJwt(900), refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(existsSync(config.credentialPath)).toBe(false);
        expect(logs).toContain('- Server session: Not revoked (server unreachable or session already ended)');
    });

    it('deletes pre-OIDC credentials without contacting the server', async () => {
        server = await startFakeServer({});
        const config = configFor(server.url);
        writeFileSync(config.credentialPath, JSON.stringify({ token: 'old', secret: encodeBase64(getRandomBytes(32)) }));
        await authLogout(config);
        expect(server.calls).toEqual([]);
        expect(existsSync(config.credentialPath)).toBe(false);
    });

    it('keeps a newer login that replaced the credentials while revocation was in flight', async () => {
        // Simulates: logout reads the old refresh token, starts revoking it on
        // the server, and while that network call is in flight a concurrent
        // `auth login` writes fresh credentials. The stale revoke must not
        // delete the new session.
        let config: Config;
        server = await startFakeServer({
            'POST /v1/auth/logout': async () => {
                writeCredentials(config, { token: makeJwt(900), refreshToken: 'refresh-new', secret: getRandomBytes(32) });
                return { status: 200, body: { success: true } };
            },
        });
        config = configFor(server.url);
        writeCredentials(config, { token: makeJwt(900), refreshToken: 'refresh-old', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(readCredentials(config)?.refreshToken).toBe('refresh-new');
    });

    it('refreshes an expired access token before revoking', async () => {
        const fresh = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: fresh, refreshToken: 'refresh-2' } }),
            'POST /v1/auth/logout': () => ({ status: 200, body: { success: true } }),
        });
        const config = configFor(server.url);
        writeCredentials(config, { token: makeJwt(-60), refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(server.calls.map((c) => c.path)).toEqual(['/v1/auth/refresh', '/v1/auth/logout']);
        expect(server.calls[1].authorization).toBe(`Bearer ${fresh}`);
        expect(existsSync(config.credentialPath)).toBe(false);
    });

    it('clears the credentials when the refresh succeeds but the logout POST fails', async () => {
        const fresh = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: fresh, refreshToken: 'refresh-2' } }),
            'POST /v1/auth/logout': () => ({ status: 500, body: { error: 'server_error' } }),
        });
        const config = configFor(server.url);
        writeCredentials(config, { token: makeJwt(-60), refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(server.calls.map((c) => c.path)).toEqual(['/v1/auth/refresh', '/v1/auth/logout']);
        expect(existsSync(config.credentialPath)).toBe(false);
        expect(logs).toContain('- Server session: Not revoked (server unreachable or session already ended)');
    });

    it('keeps a newer login that arrives during logout even after our own refresh rotated first', async () => {
        // Our own refresh rotates refresh-1 -> refresh-rotated under the lock. Then, while
        // the logout POST is in flight, a concurrent process writes a wholly new login
        // (refresh-new-login). The refresh token captured for the clear-check must be the
        // one *we* rotated to (refresh-rotated), not an unlocked re-read that could pick up
        // the concurrent write instead — otherwise this would wrongly delete the new login.
        let config!: Config;
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: makeJwt(900), refreshToken: 'refresh-rotated' } }),
            'POST /v1/auth/logout': () => {
                writeCredentials(config, { token: makeJwt(900), refreshToken: 'refresh-new-login', secret: getRandomBytes(32) });
                return { status: 200, body: { success: true } };
            },
        });
        config = configFor(server.url);
        writeCredentials(config, { token: makeJwt(-60), refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        await authLogout(config);
        expect(readCredentials(config)?.refreshToken).toBe('refresh-new-login');
    });

    it('clears the file by what it actually holds when our own refresh rotation fails to persist', async () => {
        // The refresh succeeds server-side (refresh-1 -> refresh-rotated) but persisting it
        // fails, so the file still holds refresh-1 while the store only knows refresh-rotated
        // in memory. The clear-check must still match against refresh-1 (what's really on
        // disk), not refresh-rotated — otherwise the file would survive "Logged out".
        const rotatedToken = makeJwt(900);
        server = await startFakeServer({
            'POST /v1/auth/refresh': () => ({ status: 200, body: { accessToken: rotatedToken, refreshToken: 'refresh-rotated' } }),
            'POST /v1/auth/logout': () => ({ status: 200, body: { success: true } }),
        });
        const config = configFor(server.url);
        writeCredentials(config, { token: makeJwt(-60), refreshToken: 'refresh-1', secret: getRandomBytes(32) });

        const writeSpy = vi.spyOn(credentialsModule, 'writeCredentials').mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        try {
            await authLogout(config);
        } finally {
            writeSpy.mockRestore();
        }
        expect(server.calls.map((c) => c.path)).toEqual(['/v1/auth/refresh', '/v1/auth/logout']);
        expect(existsSync(config.credentialPath)).toBe(false);
    });

    it('succeeds without credentials or a home directory', async () => {
        const config = { serverUrl: 'http://127.0.0.1:9', homeDir: join(homeDir, 'missing'), credentialPath: join(homeDir, 'missing', 'agent.key') };
        await expect(authLogout(config)).resolves.toBeUndefined();
        expect(logs).toContain('- Status: Logged out');
    });
});

describe('authStatus', () => {
    it('shows the signed-in state, server and public key without printing tokens', async () => {
        const config = configFor('https://happy.example.test');
        writeCredentials(config, { token: 'access-secret-value', refreshToken: 'refresh-secret-value', secret: getRandomBytes(32) });
        await authStatus(config);
        expect(logs).toContain('## Authentication');
        expect(logs).toContain('- Status: Authenticated');
        expect(logs).toContain('- Server: https://happy.example.test');
        expect(logs.some((l) => l.startsWith('- Public Key: `'))).toBe(true);
        const output = logs.join('\n');
        expect(output).not.toContain('access-secret-value');
        expect(output).not.toContain('refresh-secret-value');
    });

    it('treats pre-OIDC credentials as not authenticated', async () => {
        const config = configFor();
        writeFileSync(config.credentialPath, JSON.stringify({ token: 't', secret: encodeBase64(getRandomBytes(32)) }));
        await authStatus(config);
        expect(logs).toContain('- Status: Not authenticated');
        expect(logs).toContain('- Action: Run `happyco-agent auth login` to authenticate.');
    });
});
