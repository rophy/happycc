import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { clearPersistence } from '@/sync/persistence';
import { TokenStorage } from './tokenStorage';

/**
 * Local half of every logout: wipe persisted state and credentials, then restart the app.
 * The web restarts at `/`: there is no route guard, so reloading a deep link such as
 * /settings/account would render it without an account instead of the sign-in screen.
 *
 * Callers must first fence the running TokenStore (`stopAndSettle`) so a refresh
 * already in flight cannot write credentials back after this wipe.
 */
export async function wipeLocalSessionAndReload(): Promise<void> {
    clearPersistence();
    await TokenStorage.removeCredentials();
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
