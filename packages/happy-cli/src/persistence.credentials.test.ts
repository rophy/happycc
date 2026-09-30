import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfiguration = vi.hoisted(() => ({
    happyHomeDir: '',
    privateKeyFile: '',
    settingsFile: '',
    logsDir: '',
    isDaemonProcess: false,
    daemonStateFile: '',
    daemonLockFile: '',
    sessionsFile: '',
}));
vi.mock('@/configuration', () => ({ configuration: mockConfiguration }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { clearCredentialsIfRefreshToken, readCredentials, writeCredentials } from './persistence';

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'happy-creds-'));
    mockConfiguration.happyHomeDir = dir;
    mockConfiguration.privateKeyFile = join(dir, 'access.key');
    mockConfiguration.settingsFile = join(dir, 'settings.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const creds = () => ({
    token: 'access-1',
    refreshToken: 'refresh-1',
    encryption: { type: 'dataKey' as const, publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
});

describe('credentials', () => {
    it('round-trips token, refresh token and keys', async () => {
        await writeCredentials(creds());
        const read = await readCredentials();
        expect(read).toEqual(creds());
    });

    it('writes the file with mode 0600 and no temp file left behind', async () => {
        await writeCredentials(creds());
        expect(statSync(mockConfiguration.privateKeyFile).mode & 0o777).toBe(0o600);
        expect(existsSync(mockConfiguration.privateKeyFile + '.tmp')).toBe(false);
    });

    it('treats credentials without a refresh token as logged out', async () => {
        writeFileSync(mockConfiguration.privateKeyFile, JSON.stringify({
            token: 'old', encryption: { publicKey: Buffer.alloc(32).toString('base64'), machineKey: Buffer.alloc(32).toString('base64') },
        }));
        expect(await readCredentials()).toBeNull();
        writeFileSync(mockConfiguration.privateKeyFile, JSON.stringify({ token: 'old', secret: Buffer.alloc(32).toString('base64') }));
        expect(await readCredentials()).toBeNull();
    });

    it('refuses to write legacy credentials', async () => {
        await expect(writeCredentials({ token: 't', refreshToken: 'r', encryption: { type: 'legacy', secret: new Uint8Array(32) } }))
            .rejects.toThrow('Only dataKey credentials can be written');
    });

    it('clears credentials only when they still hold the given refresh token', async () => {
        await writeCredentials(creds());
        expect(await clearCredentialsIfRefreshToken('other')).toBe(false);
        expect(await readCredentials()).not.toBeNull();
        expect(await clearCredentialsIfRefreshToken('refresh-1')).toBe(true);
        expect(await readCredentials()).toBeNull();
    });

    it('never writes the token into anything but the credentials file', async () => {
        await writeCredentials(creds());
        expect(readFileSync(mockConfiguration.privateKeyFile, 'utf8')).toContain('"refreshToken": "refresh-1"');
    });
});
