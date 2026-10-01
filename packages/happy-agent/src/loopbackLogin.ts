import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    credentialsLockFile,
    ensureCredentialsDir,
    writeCredentials,
    type StoredCredentials,
} from './credentials';
import { decodeBase64, decryptBoxBundle, encodeBase64 } from './encryption';
import { withFileLock } from './fileLock';

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 15_000;

export class LoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LoginError';
    }
}

export interface LoopbackLoginIO {
    print(line: string): void;
    /**
     * Optional hook invoked once with the login URL, before it is printed.
     * The CLI uses this to try opening the user's browser; it is never
     * called by the tests, so no test launches a real browser. Errors are
     * the caller's concern — loopbackLogin itself never throws from this.
     */
    onUrl?(url: string): void | Promise<void>;
}

type CallbackResult = { code: string } | { error: string };

type ExchangeResponse = {
    accountId: string;
    accessToken: string;
    refreshToken: string;
    keyBundle: string;
};

function page(title: string, message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
        + `<body style="font-family: system-ui, sans-serif; margin: 3rem;"><h1>${title}</h1><p>${message}</p></body></html>`;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', connection: 'close' });
    res.end(body);
}

/** One-shot listener on http://127.0.0.1:<random port>/callback (RFC 8252 loopback redirect). */
async function startCallbackListener(): Promise<{ redirectUri: string; result: Promise<CallbackResult>; close(): void }> {
    let settle!: (result: CallbackResult) => void;
    const result = new Promise<CallbackResult>((resolve) => { settle = resolve; });
    let handled = false;
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== '/callback') {
            send(res, 404, 'text/plain; charset=utf-8', 'Not found');
            return;
        }
        if (handled) {
            send(res, 400, 'text/html; charset=utf-8', page('Already handled', 'This sign-in was already handled. You can close this tab.'));
            return;
        }
        handled = true;
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code) {
            send(res, 400, 'text/html; charset=utf-8', page('Sign-in failed', 'Return to your terminal and run happy-agent auth login again.'));
            settle({
                error: url.searchParams.has('error')
                    ? 'Sign-in was cancelled or denied in the browser.'
                    : 'The sign-in callback did not include a code.',
            });
            return;
        }
        send(res, 200, 'text/html; charset=utf-8', page('Signed in', 'You can close this tab and return to your terminal.'));
        settle({ code });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        result,
        close: () => {
            server.close();
            server.closeIdleConnections();
        },
    };
}

export async function loopbackLogin(opts: {
    config: Config;
    deviceName: string;
    io: LoopbackLoginIO;
    timeoutMs?: number;
}): Promise<StoredCredentials> {
    const { config, io } = opts;
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const ephemeral = tweetnacl.box.keyPair();

    const listener = await startCallbackListener();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let callback: CallbackResult;
    try {
        const params = new URLSearchParams({ client: 'loopback', code_challenge: codeChallenge, redirect_uri: listener.redirectUri });
        const loginUrl = `${config.serverUrl}/v1/auth/oidc/login?${params.toString()}`;
        try {
            await io.onUrl?.(loginUrl);
        } catch {
            // Opening the browser is best-effort; the URL is still printed below.
        }
        io.print('');
        io.print('To sign in, open this URL in a browser on this machine:');
        io.print('');
        io.print(`  ${loginUrl}`);
        io.print('');
        io.print('After you sign in, click Allow on the confirmation page to approve this device.');
        io.print('Waiting for the browser to finish signing in...');
        const timeout = new Promise<CallbackResult>((resolve) => {
            timer = setTimeout(
                () => resolve({ error: 'Sign-in timed out. Run `happy-agent auth login` again.' }),
                opts.timeoutMs ?? LOGIN_TIMEOUT_MS,
            );
        });
        callback = await Promise.race([listener.result, timeout]);
    } finally {
        clearTimeout(timer);
        listener.close();
    }
    if ('error' in callback) {
        throw new LoginError(callback.error);
    }

    let tokens: ExchangeResponse;
    try {
        const response = await axios.post(`${config.serverUrl}/v1/auth/oidc/exchange`, {
            code: callback.code,
            codeVerifier,
            ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
            deviceName: opts.deviceName.slice(0, 100),
        }, {
            timeout: EXCHANGE_TIMEOUT_MS,
            signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
            headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
        });
        tokens = response.data as ExchangeResponse;
    } catch (error) {
        // Only status and the server's error code; never the request config (it holds the code verifier).
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const serverError = axios.isAxiosError(error) ? (error.response?.data as { error?: unknown } | undefined)?.error : undefined;
        const detail = `${status ?? 'no response'}${typeof serverError === 'string' ? ` ${serverError}` : ''}`;
        throw new LoginError(`Sign-in failed: the server rejected the code exchange (${detail}).`);
    }

    const secret = decryptBoxBundle(decodeBase64(tokens.keyBundle), ephemeral.secretKey);
    if (!secret || secret.length !== 32) {
        throw new LoginError('Received an invalid key bundle from the server.');
    }
    const credentials: StoredCredentials = { token: tokens.accessToken, refreshToken: tokens.refreshToken, secret };
    ensureCredentialsDir(config);
    await withFileLock(credentialsLockFile(config), async () => writeCredentials(config, credentials), CREDENTIALS_LOCK_OPTIONS);
    return credentials;
}
