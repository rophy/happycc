import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { clearPersistence } from '@/sync/persistence';
import { TokenStorage } from './tokenStorage';

/**
 * Restarts the app. The web restarts at `/`: there is no route guard, so reloading a
 * deep link such as /settings/account would render it without an account instead of
 * the sign-in screen.
 */
async function reloadApp(): Promise<void> {
    if (Platform.OS === 'web') {
        window.location.replace('/');
        return;
    }
    try {
        await Updates.reloadAsync();
    } catch {
        // In dev builds reloadAsync throws ERR_UPDATES_DISABLED.
        console.log('Reload failed (expected in dev mode)');
    }
}

/**
 * Local half of an explicit logout: wipe persisted state and credentials, then restart.
 *
 * Callers must first fence the running TokenStore (`stopAndSettle`) so a refresh
 * already in flight cannot write credentials back after this wipe.
 */
export async function wipeLocalSessionAndReload(): Promise<void> {
    clearPersistence();
    await TokenStorage.removeCredentials();
    await reloadApp();
}

/**
 * The server rejected `failedRefreshToken` (invalid_grant). Removes the stored
 * credentials only if they still hold that token, so another tab's fresh sign-in
 * survives. Local session data is wiped only when no credentials remain; otherwise
 * the app just restarts on the credentials that are there.
 */
export async function endRejectedSessionAndReload(failedRefreshToken: string | undefined): Promise<void> {
    if (failedRefreshToken) {
        await TokenStorage.removeCredentialsIfRefreshToken(failedRefreshToken);
    }
    if ((await TokenStorage.getCredentials()) === null) {
        clearPersistence();
    }
    await reloadApp();
}
