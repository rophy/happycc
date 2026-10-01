/**
 * Platform wiring for the TokenStore: storage, the web refresh lock
 * (navigator.locks 'happy-auth-refresh', or the localStorage lease lock where
 * navigator.locks is missing), cross-tab sync via the `storage` event, and the
 * invalid_grant → logout path.
 */
import { Platform } from 'react-native';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import { setAccessTokenProvider, setServerUrlAccessor } from './authFetch';
import { createLeaseLock } from './leaseLock';
import { endRejectedSessionAndReload } from './logout';
import { AUTH_KEY, TokenStorage, type AuthCredentials } from './tokenStorage';
import { TokenStore } from './tokenStore';

const REFRESH_LOCK_NAME = 'happy-auth-refresh';

type WithLock = <T>(fn: () => Promise<T>) => Promise<T>;

let store: TokenStore | null = null;
let storageListenerInstalled = false;
let webLock: WithLock | undefined;

// Lets authFetch pass other-origin requests through even before the first sign-in.
setServerUrlAccessor(getServerUrl);

/** Web only: cross-tab exclusion for refresh. Native has one store per process (single-flight). */
function webRefreshLock(): WithLock | undefined {
    if (Platform.OS !== 'web') {
        return undefined;
    }
    if (!webLock) {
        if (typeof navigator !== 'undefined' && navigator.locks) {
            webLock = <T>(fn: () => Promise<T>) => navigator.locks.request(REFRESH_LOCK_NAME, fn) as Promise<T>;
        } else {
            // Non-secure origins (plain HTTP) have no navigator.locks; see leaseLock.ts.
            webLock = createLeaseLock(window.localStorage).withLock;
        }
    }
    return webLock;
}

function installStorageListener(): void {
    if (storageListenerInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
        return;
    }
    storageListenerInstalled = true;
    window.addEventListener('storage', (event: StorageEvent) => {
        // key === null means localStorage.clear() in another tab.
        if (event.key !== AUTH_KEY && event.key !== null) {
            return;
        }
        const result = store?.applyExternalChange(event.key === null ? null : event.newValue);
        if (result === 'reload') {
            // Signed out (or into another account) in another tab: restart at home.
            window.location.replace('/');
        }
    });
}

/**
 * Starts the store for `credentials` and registers it with authFetch. Any previous
 * store is stopped and its in-flight refresh settled first, so it can never write
 * over the new credentials.
 */
export async function startTokenStore(credentials: AuthCredentials): Promise<TokenStore> {
    await stopTokenStore();
    const isWeb = Platform.OS === 'web';
    const next = new TokenStore(credentials, {
        serverUrl: getServerUrl,
        read: isWeb ? () => TokenStorage.getCredentials() : undefined,
        write: async (value) => {
            if (!(await TokenStorage.setCredentials(value))) {
                throw new Error('Failed to persist credentials');
            }
        },
        clearIfRefreshToken: (refreshToken) => TokenStorage.removeCredentialsIfRefreshToken(refreshToken),
        onLoggedOut: (failedRefreshToken) => {
            void (async () => {
                await next.stopAndSettle();
                await endRejectedSessionAndReload(failedRefreshToken);
            })();
        },
        withLock: webRefreshLock(),
        clientId: getHappyClientId,
    });
    store = next;
    setAccessTokenProvider(next);
    if (isWeb) {
        installStorageListener();
    }
    return next;
}

export function getRuntimeTokenStore(): TokenStore | null {
    return store;
}

/**
 * Stops the running store, unregisters it from authFetch and waits (bounded, ~6 s)
 * for its in-flight refresh to settle. Call before wiping or replacing credentials.
 */
export async function stopTokenStore(): Promise<void> {
    const previous = store;
    store = null;
    if (previous) {
        setAccessTokenProvider(null);
        await previous.stopAndSettle();
    }
}
