import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { readCredentials, updateSettings, writeCredentials, type Credentials } from '@/persistence';
import { credentialsLockFile, tokenStore, CREDENTIALS_LOCK_OPTIONS } from '@/api/tokenStore';
import { withFileLock } from '@/utils/fileLock';
import { delay } from '@/utils/time';
import { displayQRCode } from './qrcode';
import { logger } from './logger';

export class DeviceLoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeviceLoginError';
    }
}

export interface DeviceLoginIO {
    print(line: string): void;
    showQr(url: string): void;
    sleep(ms: number): Promise<void>;
}

interface DeviceStart {
    deviceCode: string;
    userCode: string;
    verifyUrl: string;
    verifyUrlComplete: string;
    interval: number;
    expiresIn: number;
}

interface DeviceTokens {
    accountId: string;
    accessToken: string;
    refreshToken: string;
    keyBundle: string;
}

const TERMINAL_ERRORS: Record<string, string> = {
    access_denied: 'Sign-in was denied in the browser.',
    expired_token: 'The sign-in code expired. Run "happycc auth login" again.',
    invalid_grant: 'Sign-in failed. Run "happycc auth login" again.',
};

export async function deviceLogin(opts: {
    serverUrl: string;
    clientInfo: { host: string; os: string; cliVersion: string };
    io: DeviceLoginIO;
}): Promise<Credentials> {
    const { serverUrl, clientInfo, io } = opts;
    const ephemeral = tweetnacl.box.keyPair();

    const start = (await axios.post<DeviceStart>(`${serverUrl}/v1/auth/device/start`, {
        ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
        clientInfo,
    }, { timeout: 15_000 })).data;

    io.print('');
    io.print('To sign in, open this URL in a browser:');
    io.print('');
    io.print(`  ${start.verifyUrlComplete}`);
    io.print('');
    io.print(`and confirm the code: ${start.userCode}`);
    io.print('');
    io.showQr(start.verifyUrlComplete);
    io.print('Waiting for approval...');

    let intervalMs = Math.max(1, start.interval) * 1000;
    const deadline = Date.now() + start.expiresIn * 1000;
    let tokens: DeviceTokens | null = null;
    while (!tokens) {
        if (Date.now() > deadline) {
            throw new DeviceLoginError(TERMINAL_ERRORS.expired_token);
        }
        await io.sleep(intervalMs);
        try {
            tokens = (await axios.post<DeviceTokens>(`${serverUrl}/v1/auth/device/token`, {
                deviceCode: start.deviceCode,
            }, { timeout: 15_000 })).data;
        } catch (error) {
            const code = axios.isAxiosError(error) && error.response?.status === 400
                ? (error.response.data as { error?: string } | undefined)?.error
                : undefined;
            if (code === 'slow_down') {
                intervalMs += 5000;
            } else if (code && TERMINAL_ERRORS[code]) {
                throw new DeviceLoginError(TERMINAL_ERRORS[code]);
            } else if (code !== 'authorization_pending') {
                logger.debug('[AUTH] Device token poll failed; retrying', error instanceof Error ? error.message : error);
            }
        }
    }

    const bundle = decryptWithEphemeralKey(decodeBase64(tokens.keyBundle), ephemeral.secretKey);
    if (!bundle || bundle.length !== 33 || bundle[0] !== 0) {
        throw new DeviceLoginError('Received an invalid key bundle from the server.');
    }
    const credentials: Credentials = {
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        encryption: {
            type: 'dataKey',
            publicKey: bundle.slice(1, 33),
            machineKey: new Uint8Array(randomBytes(32)),
        },
    };
    await withFileLock(credentialsLockFile(), () => writeCredentials(credentials), CREDENTIALS_LOCK_OPTIONS);
    io.print('✓ Signed in');
    return credentials;
}

export async function doAuth(): Promise<Credentials | null> {
    const handleInterrupt = () => {
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };
    process.on('SIGINT', handleInterrupt);
    try {
        return await deviceLogin({
            serverUrl: configuration.serverUrl,
            clientInfo: { host: os.hostname(), os: process.platform, cliVersion: configuration.currentCliVersion },
            io: { print: (line) => console.log(line), showQr: displayQRCode, sleep: async (ms) => { await delay(ms); } },
        });
    } catch (error) {
        console.log(`\n${error instanceof Error ? error.message : 'Sign-in failed.'}\n`);
        return null;
    } finally {
        process.off('SIGINT', handleInterrupt);
    }
}

export function decryptWithEphemeralKey(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, 32);
    const nonce = encryptedBundle.slice(32, 32 + tweetnacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(32 + tweetnacl.box.nonceLength);
    return tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey) ?? null;
}

/**
 * Ensure authentication and machine setup
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }
    // replace(), not init(): init() is a no-op once a token is already held,
    // which would silently keep serving a stale (possibly just-revoked) token
    // from an earlier tokenStore.getAccessToken() call in this same process
    // (e.g. `auth login --force`'s performLogout, before the device login
    // above wrote fresh credentials).
    tokenStore.replace(credentials);

    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            return { ...s, machineId: randomUUID() };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);
    return { credentials, machineId: settings.machineId! };
}
