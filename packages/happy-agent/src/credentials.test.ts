import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from './config';
import {
    clearCredentials,
    clearCredentialsIfRefreshToken,
    credentialsLockFile,
    readCredentials,
    requireCredentials,
    writeCredentials,
} from './credentials';
import { deriveContentKeyPair, encodeBase64, getRandomBytes } from './encryption';

let homeDir: string;
let config: Config;

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happy-agent-creds-'));
    config = { serverUrl: 'https://api.example.test', homeDir, credentialPath: join(homeDir, 'nested', 'agent.key') };
});
afterEach(() => { rmSync(homeDir, { recursive: true, force: true }); });

describe('credentials', () => {
    it('round-trips token, refresh token and secret, and derives the content key pair', () => {
        const secret = getRandomBytes(32);
        writeCredentials(config, { token: 'access-1', refreshToken: 'refresh-1', secret });
        const read = readCredentials(config)!;
        expect(read.token).toBe('access-1');
        expect(read.refreshToken).toBe('refresh-1');
        expect(read.secret).toEqual(secret);
        expect(read.contentKeyPair).toEqual(deriveContentKeyPair(secret));
    });

    it('writes {token, refreshToken, secret} with mode 0600 and leaves no temp file', () => {
        const secret = getRandomBytes(32);
        writeCredentials(config, { token: 'access-1', refreshToken: 'refresh-1', secret });
        expect(statSync(config.credentialPath).mode & 0o777).toBe(0o600);
        expect(existsSync(`${config.credentialPath}.tmp`)).toBe(false);
        expect(JSON.parse(readFileSync(config.credentialPath, 'utf-8'))).toEqual({
            token: 'access-1',
            refreshToken: 'refresh-1',
            secret: encodeBase64(secret),
        });
    });

    it('treats pre-OIDC credentials without a refresh token as logged out', () => {
        writeCredentials(config, { token: 't', refreshToken: 'r', secret: getRandomBytes(32) });
        writeFileSync(config.credentialPath, JSON.stringify({ token: 'old', secret: encodeBase64(getRandomBytes(32)) }));
        expect(readCredentials(config)).toBeNull();
    });

    it('returns null for a missing file, invalid JSON or a wrong-length secret', () => {
        expect(readCredentials(config)).toBeNull();
        writeCredentials(config, { token: 't', refreshToken: 'r', secret: getRandomBytes(32) });
        writeFileSync(config.credentialPath, '{not json');
        expect(readCredentials(config)).toBeNull();
        writeFileSync(config.credentialPath, JSON.stringify({ token: 't', refreshToken: 'r', secret: encodeBase64(getRandomBytes(16)) }));
        expect(readCredentials(config)).toBeNull();
    });

    it('clears credentials only while they still hold the given refresh token', () => {
        writeCredentials(config, { token: 't', refreshToken: 'refresh-1', secret: getRandomBytes(32) });
        expect(clearCredentialsIfRefreshToken(config, 'other')).toBe(false);
        expect(readCredentials(config)).not.toBeNull();
        expect(clearCredentialsIfRefreshToken(config, 'refresh-1')).toBe(true);
        expect(existsSync(config.credentialPath)).toBe(false);
    });

    it('clearCredentials tolerates a missing file', () => {
        expect(() => clearCredentials(config)).not.toThrow();
    });

    it('requireCredentials points at auth login', () => {
        expect(() => requireCredentials(config)).toThrow('Not authenticated. Run `happycc-agent auth login` first.');
    });

    it('locks next to the credentials file', () => {
        expect(credentialsLockFile(config)).toBe(`${config.credentialPath}.lock`);
    });
});
