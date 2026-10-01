import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import axios from 'axios';
import open from 'open';
import type { Config } from './config';
import {
    CREDENTIALS_LOCK_OPTIONS,
    clearCredentials,
    credentialsLockFile,
    readCredentials,
    type Credentials,
} from './credentials';
import { encodeBase64 } from './encryption';
import { withFileLock } from './fileLock';
import { loopbackLogin } from './loopbackLogin';

const LOGOUT_TIMEOUT_MS = 5_000;

/**
 * Signs in through the browser (OIDC loopback + PKCE). By default it also
 * tries to open the login URL in the user's default browser; if that fails
 * (headless box, no `open` handler, etc.) it keeps going quietly — the URL
 * is always printed too. Pass `openBrowser: false` for `--no-browser`.
 */
export async function authLogin(config: Config, opts?: { openBrowser?: boolean }): Promise<void> {
    const openBrowser = opts?.openBrowser ?? true;
    await loopbackLogin({
        config,
        deviceName: `happy-agent@${hostname()}`,
        io: {
            print: (line) => console.log(line),
            onUrl: async (url) => {
                if (!openBrowser) {
                    return;
                }
                try {
                    await open(url);
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

/** Best effort: the local logout proceeds whatever happens here. */
async function revokeOnServer(config: Config, creds: Credentials): Promise<boolean> {
    try {
        await axios.post(`${config.serverUrl}/v1/auth/logout`, {}, {
            headers: { Authorization: `Bearer ${creds.token}`, 'X-Happy-Client': 'cli-control-plane/0.1.0' },
            timeout: LOGOUT_TIMEOUT_MS,
            signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        });
        return true;
    } catch {
        return false;
    }
}

export async function authLogout(config: Config): Promise<void> {
    const creds = readCredentials(config);
    const revoked = creds ? await revokeOnServer(config, creds) : null;
    if (existsSync(config.credentialPath)) {
        await withFileLock(credentialsLockFile(config), async () => clearCredentials(config), CREDENTIALS_LOCK_OPTIONS);
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
