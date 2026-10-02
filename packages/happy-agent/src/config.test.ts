import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';

describe('config', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.HAPPY_SERVER_URL = 'https://happy.corp.example';
        delete process.env.HAPPY_HOME_DIR;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('server URL', () => {
        it('has no built-in default', () => {
            delete process.env.HAPPY_SERVER_URL;
            expect(() => loadConfig()).toThrow('HAPPY_SERVER_URL is not set');
        });

        it('treats a blank HAPPY_SERVER_URL as unset', () => {
            process.env.HAPPY_SERVER_URL = '   ';
            expect(() => loadConfig()).toThrow('HAPPY_SERVER_URL is not set');
        });

        it('uses HAPPY_SERVER_URL without trailing slashes', () => {
            process.env.HAPPY_SERVER_URL = 'https://custom-server.example.com//';
            expect(loadConfig().serverUrl).toBe('https://custom-server.example.com');
        });
    });

    describe('home directory', () => {
        it('uses default home directory', () => {
            expect(loadConfig().homeDir).toBe(join(homedir(), '.happyco'));
        });

        it('derives credential path from home directory', () => {
            expect(loadConfig().credentialPath).toBe(join(homedir(), '.happyco', 'agent.key'));
        });

        it('overrides home directory with HAPPY_HOME_DIR', () => {
            process.env.HAPPY_HOME_DIR = '/tmp/custom-happy';
            const config = loadConfig();
            expect(config.homeDir).toBe('/tmp/custom-happy');
            expect(config.credentialPath).toBe('/tmp/custom-happy/agent.key');
        });

        it('expands a leading ~ in HAPPY_HOME_DIR, same as happy-cli', () => {
            process.env.HAPPY_HOME_DIR = '~/custom-happy';
            const config = loadConfig();
            expect(config.homeDir).toBe(join(homedir(), 'custom-happy'));
            expect(config.credentialPath).toBe(join(homedir(), 'custom-happy', 'agent.key'));
        });

        it('expands a bare ~ in HAPPY_HOME_DIR', () => {
            process.env.HAPPY_HOME_DIR = '~';
            expect(loadConfig().homeDir).toBe(homedir());
        });
    });
});
