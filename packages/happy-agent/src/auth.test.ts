import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { writeCredentials } from './credentials';
import { encodeBase64, getRandomBytes } from './encryption';
import { makeJwt, startFakeServer } from './testing/fakeServer';

vi.mock('./loopbackLogin', () => ({
    loopbackLogin: vi.fn(async (opts: { io: { print(line: string): void; onUrl?(url: string): void | Promise<void> } }) => {
        await opts.io.onUrl?.('https://idp.example.test/login?loginUrl=1');
        return { token: 'access-token', refreshToken: 'refresh-token', secret: new Uint8Array(32) };
    }),
}));

// `open` must never actually launch a browser in tests; it is always mocked.
vi.mock('open', () => ({ default: vi.fn(async () => ({})) }));

import open from 'open';
import { loopbackLogin } from './loopbackLogin';
import { authLogin, authLogout, authStatus } from './auth';

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
    it('signs in as happy-agent@<host> and reports success without printing tokens', async () => {
        const config = configFor();
        await authLogin(config);
        const call = vi.mocked(loopbackLogin).mock.calls[0][0];
        expect(call.config).toBe(config);
        expect(call.deviceName).toMatch(/^happy-agent@.+/);
        expect(logs).toContain('- Status: Authenticated');
        expect(logs.join('\n')).not.toContain('access-token');
    });

    it('opens the browser with the login URL by default', async () => {
        await authLogin(configFor());
        expect(vi.mocked(open)).toHaveBeenCalledWith('https://idp.example.test/login?loginUrl=1');
    });

    it('does not open the browser when openBrowser is false (--no-browser)', async () => {
        await authLogin(configFor(), { openBrowser: false });
        expect(vi.mocked(open)).not.toHaveBeenCalled();
    });

    it('keeps going quietly and still signs in when opening the browser fails', async () => {
        vi.mocked(open).mockRejectedValueOnce(new Error('no display'));
        await expect(authLogin(configFor())).resolves.toBeUndefined();
        expect(logs).toContain('- Status: Authenticated');
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
        expect(logs).toContain('- Action: Run `happy-agent auth login` to authenticate.');
    });
});
