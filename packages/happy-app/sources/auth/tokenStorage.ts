import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { parseStoredCredentials, type StoredCredentials } from './tokenStore';

export const AUTH_KEY = 'auth_credentials';

/** `{ token, refreshToken, secret }`; see tokenStore.ts. */
export type AuthCredentials = StoredCredentials;

async function readRaw(): Promise<string | null> {
    if (Platform.OS === 'web') {
        return localStorage.getItem(AUTH_KEY);
    }
    return SecureStore.getItemAsync(AUTH_KEY);
}

export const TokenStorage = {
    /** Null when nothing usable is stored. Pre-OIDC values (no refresh token) are removed. */
    async getCredentials(): Promise<AuthCredentials | null> {
        let raw: string | null;
        try {
            raw = await readRaw();
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
        const credentials = parseStoredCredentials(raw);
        if (raw && !credentials) {
            await TokenStorage.removeCredentials();
        }
        return credentials;
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const json = JSON.stringify(credentials);
        try {
            if (Platform.OS === 'web') {
                localStorage.setItem(AUTH_KEY, json);
            } else {
                await SecureStore.setItemAsync(AUTH_KEY, json);
            }
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        try {
            if (Platform.OS === 'web') {
                localStorage.removeItem(AUTH_KEY);
            } else {
                await SecureStore.deleteItemAsync(AUTH_KEY);
            }
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },

    /** Leaves newer credentials (another tab's fresh sign-in) alone. */
    async removeCredentialsIfRefreshToken(refreshToken: string): Promise<void> {
        const current = await TokenStorage.getCredentials();
        if (current?.refreshToken === refreshToken) {
            await TokenStorage.removeCredentials();
        }
    },
};
