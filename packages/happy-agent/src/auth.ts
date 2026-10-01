import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import axios from 'axios';
import open from 'open';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    clearCredentials,
    clearCredentialsIfRefreshToken,
    credentialsLockFile,
    readCredentials,
    type Credentials,
} from './credentials';
import { encodeBase64 } from './encryption';
import { withFileLock } from './fileLock';
import { loopbackLogin } from './loopbackLogin';
import { TokenStore } from './tokenStore';

const LOGOUT_TIMEOUT_MS = 5_000;

/** Mirrors packages/happy-cli/src/utils/browser.ts: never try to spawn a browser headlessly. */
function shouldOpenBrowser(openBrowser: boolean): boolean {
    return openBrowser && Boolean(process.stdout.isTTY) && !process.env.CI && !process.env.HEADLESS;
}

/**
 * Signs in through the browser (OIDC loopback + PKCE). By default it also
 * tries to open the login URL in the user's default browser (skipped in a
 * headless/CI environment, or with `openBrowser: false` for `--no-browser`);
 * if opening fails for any reason it keeps going quietly — the URL is
 * always printed too.
 */
export async function authLogin(config: Config, opts?: { openBrowser?: boolean }): Promise<void> {
    const openBrowser = opts?.openBrowser ?? true;
    await loopbackLogin({
        config,
        deviceName: `happy-agent@${hostname()}`,
        io: {
            print: (line) => console.log(line),
            onUrl: async (url) => {
                if (!shouldOpenBrowser(openBrowser)) {
                    return;
                }
                try {
                    // `open()` resolves with the spawned child process. Without an
                    // 'error' listener, a failed spawn (missing xdg-open, WSL
                    // without powershell.exe, ...) emits an unhandled 'error' that
                    // would crash the process mid-login.
                    const child = await open(url);
                    child.on('error', () => {});
                } catch {
                    // Best effort only; the URL was already printed to stdout.
                }
            },
        },
    });
    console.log('');
    console.log('## Authentication');
    console.log('- Status: Authenticated');
}

/**
 * Best effort: the local logout proceeds whatever happens here (refresh ≤10 s, logout ≤5 s).
 * Returns the refresh token to treat as "ours" for the clear-on-logout check below: if an
 * expired access token needed refreshing first, that refresh already rotated the file to a
 * new refresh token under the credentials lock — still the same login, not a concurrent one.
 */
async function revokeOnServer(config: Config, creds: Credentials): Promise<{ revoked: boolean; refreshToken: string }> {
    // `currentRefreshToken()` reflects whatever this store last saw or wrote *under the
    // credentials lock* — if the access token needed refreshing, that already happened by
    // the time getAccessToken() resolves, so this is "ours" even if the later logout POST
    // fails. An unlocked re-read here instead could capture a concurrent login's token,
    // and then wrongly clear the file for a session this call never touched.
    const tokenStore = new TokenStore(config, creds);
    try {
        const token = await tokenStore.getAccessToken();
        await axios.post(`${config.serverUrl}/v1/auth/logout`, {}, {
            headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'cli-control-plane/0.1.0' },
            timeout: LOGOUT_TIMEOUT_MS,
            signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        });
        return { revoked: true, refreshToken: tokenStore.currentRefreshToken() ?? creds.refreshToken };
    } catch {
        return { revoked: false, refreshToken: tokenStore.currentRefreshToken() ?? creds.refreshToken };
    }
}

export async function authLogout(config: Config): Promise<void> {
    const creds = readCredentials(config);
    const result = creds ? await revokeOnServer(config, creds) : null;
    const revoked = result?.revoked ?? null;
    if (existsSync(config.credentialPath)) {
        await withFileLock(credentialsLockFile(config), async () => {
            if (creds && result) {
                // Only clear if the file still holds the refresh token we just
                // revoked — a concurrent `auth login` may have replaced it with
                // a newer session, which must survive this logout.
                clearCredentialsIfRefreshToken(config, result.refreshToken);
            } else {
                // No valid (post-OIDC) credentials were read — e.g. a pre-OIDC
                // file with no refresh token — so there is nothing to race on.
                clearCredentials(config);
            }
        }, CREDENTIALS_LOCK_OPTIONS);
    }
    console.log('## Authentication');
    console.log('- Status: Logged out');
    if (revoked !== null) {
        console.log(revoked
            ? '- Server session: Revoked'
            : '- Server session: Not revoked (server unreachable or session already ended)');
    }
    console.log('- Credentials: Cleared');
}

export async function authStatus(config: Config): Promise<void> {
    const creds = readCredentials(config);
    console.log('## Authentication');
    if (creds) {
        console.log('- Status: Authenticated');
        console.log(`- Server: ${config.serverUrl}`);
        console.log(`- Public Key: \`${encodeBase64(creds.contentKeyPair.publicKey)}\``);
    } else {
        console.log('- Status: Not authenticated');
        console.log('- Action: Run `happy-agent auth login` to authenticate.');
    }
}
