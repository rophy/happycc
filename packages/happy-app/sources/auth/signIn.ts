import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as WebBrowser from 'expo-web-browser';
import { getServerUrl } from '@/sync/serverConfig';
import { isMobileCallbackDenied, parseMobileCallbackUrl } from './callbackUrls';
import {
    OidcLoginError,
    buildLoginUrl,
    createPendingLogin,
    deserializePendingLogin,
    exchangeCode,
    serializePendingLogin,
} from './oidcLogin';
import type { AuthCredentials } from './tokenStorage';

const PENDING_LOGIN_KEY = 'happy-oidc-pending';

/** The build's URL scheme (app.config `scheme`, from APP_CONFIG `scheme`). */
export function getAppScheme(): string {
    const scheme = Constants.expoConfig?.scheme;
    const value = Array.isArray(scheme) ? scheme[0] : scheme;
    if (!value) {
        throw new OidcLoginError('This build has no URL scheme configured.');
    }
    return value;
}

/**
 * Starts sign-in. Web: stores the PKCE verifier and ephemeral key in sessionStorage
 * and navigates to the server (resolves null; the page unloads). Native: runs the
 * system auth session and resolves credentials, or null if the user cancelled.
 */
export async function signIn(): Promise<AuthCredentials | null> {
    // PKCE and the key exchange need crypto.subtle, which browsers only expose in a
    // secure context. Say so instead of failing somewhere inside the redirect.
    if (Platform.OS === 'web' && !window.isSecureContext) {
        throw new OidcLoginError('This web app must be served over HTTPS (or localhost).');
    }
    const serverUrl = getServerUrl();
    const pending = await createPendingLogin();
    if (Platform.OS === 'web') {
        window.sessionStorage.setItem(PENDING_LOGIN_KEY, serializePendingLogin(pending));
        window.location.assign(buildLoginUrl({ serverUrl, pending, client: 'web' }));
        return null;
    }
    const redirectUri = `${getAppScheme()}://auth/callback`;
    const result = await WebBrowser.openAuthSessionAsync(
        buildLoginUrl({ serverUrl, pending, client: 'mobile', redirectUri }),
        redirectUri,
    );
    if (result.type !== 'success') {
        return null;
    }
    const code = parseMobileCallbackUrl(result.url, redirectUri);
    if (!code) {
        if (isMobileCallbackDenied(result.url, redirectUri)) {
            throw new OidcLoginError('Sign-in was cancelled');
        }
        throw new OidcLoginError('Sign-in did not return a code. Please try again.');
    }
    return exchangeCode({ serverUrl, code, pending, deviceName: Device.modelName ?? Platform.OS });
}

/** Web: drops the stored PKCE verifier and ephemeral key of an unfinished sign-in. */
export function discardPendingWebLogin(): void {
    window.sessionStorage.removeItem(PENDING_LOGIN_KEY);
}

/** Web: finishes the sign-in started by signIn() after the server redirected back. */
export async function completeWebSignIn(code: string): Promise<AuthCredentials> {
    const raw = window.sessionStorage.getItem(PENDING_LOGIN_KEY);
    discardPendingWebLogin();
    const pending = raw ? deserializePendingLogin(raw) : null;
    if (!pending) {
        throw new OidcLoginError('This sign-in was started in another tab or has expired. Please sign in again.');
    }
    return exchangeCode({ serverUrl: getServerUrl(), code, pending, deviceName: 'Web' });
}
