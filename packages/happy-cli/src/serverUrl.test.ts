import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandNeedsServerUrl, missingServerUrlMessage } from './serverUrl';

describe('commandNeedsServerUrl', () => {
    it.each([
        [[]],
        [['codex']],
        [['auth', 'login']],
        [['auth', 'status']],
        [['daemon', 'start']],
        [['daemon', 'start-sync']],
        [['resume', 'abc']],
        [['connect', 'claude']],
    ])('requires a server for %j', (args) => {
        expect(commandNeedsServerUrl(args)).toBe(true);
    });

    it.each([
        [['--help']],
        [['-h']],
        [['--version']],
        [['-v']],
        [['auth', '--help']],
        [['doctor']],
        [['doctor', 'clean']],
        [['bye']],
        [['daemon']],
        [['daemon', 'status']],
        [['daemon', 'stop']],
        [['daemon', 'list']],
        [['daemon', 'logs']],
    ])('runs %j without a server', (args) => {
        expect(commandNeedsServerUrl(args)).toBe(false);
    });

    it('names HAPPY_SERVER_URL and the settings file', () => {
        const message = missingServerUrlMessage('/home/u/.happy/settings.json');
        expect(message.startsWith('HAPPY_SERVER_URL is not set')).toBe(true);
        expect(message).toContain('/home/u/.happy/settings.json');
    });

    it('includes a copy-paste export hint', () => {
        const message = missingServerUrlMessage('/home/u/.happycc/settings.json');
        expect(message).toContain('export HAPPY_SERVER_URL=');
    });
});

describe('configuration default home directory', () => {
    const savedEnv = { ...process.env };
    let fakeHome: string;

    beforeEach(() => {
        fakeHome = mkdtempSync(join(tmpdir(), 'happy-home-'));
        delete process.env.HAPPY_HOME_DIR;
        vi.resetModules();
        vi.doMock('node:os', async () => {
            const actual = await vi.importActual<typeof import('node:os')>('node:os');
            return { ...actual, homedir: () => fakeHome };
        });
    });

    afterEach(() => {
        vi.doUnmock('node:os');
        process.env = { ...savedEnv };
        rmSync(fakeHome, { recursive: true, force: true });
    });

    it('defaults to ~/.happycc when HAPPY_HOME_DIR is not set', async () => {
        const { configuration } = await import('./configuration');
        expect(configuration.happyHomeDir).toBe(join(fakeHome, '.happycc'));
    });
});

describe('configuration server URL', () => {
    const savedEnv = { ...process.env };
    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'happy-url-'));
        process.env.HAPPY_HOME_DIR = home;
        delete process.env.HAPPY_SERVER_URL;
        delete process.env.HAPPY_WEBAPP_URL;
        vi.resetModules();
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        rmSync(home, { recursive: true, force: true });
    });

    it('has no built-in default', async () => {
        const { configuration } = await import('./configuration');
        expect(configuration.hasServerUrl).toBe(false);
        expect(configuration.webappUrl).toBeNull();
        expect(() => configuration.serverUrl).toThrow('HAPPY_SERVER_URL is not set');
    });

    it('uses HAPPY_SERVER_URL', async () => {
        process.env.HAPPY_SERVER_URL = 'https://happy.corp.example';
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://happy.corp.example');
    });

    it('falls back to serverUrl in settings.json', async () => {
        writeFileSync(join(home, 'settings.json'), JSON.stringify({ serverUrl: 'https://from-settings.corp.example' }));
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://from-settings.corp.example');
    });
});

describe('happy without a server URL', () => {
    it('exits with an error naming HAPPY_SERVER_URL instead of contacting a default host', () => {
        const home = mkdtempSync(join(tmpdir(), 'happy-url-cli-'));
        try {
            const entry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
            const result = spawnSync(process.execPath, ['--no-warnings', entry, 'auth', 'status'], {
                env: { ...process.env, HAPPY_HOME_DIR: home, HAPPY_SERVER_URL: '', HAPPY_WEBAPP_URL: '' },
                encoding: 'utf8',
                timeout: 30_000,
            });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('HAPPY_SERVER_URL is not set');
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
