import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import { loadRegisteredPushToken } from '@/sync/persistence';
import { unregisterPushToken } from '@/sync/apiPush';
import { trackLogout } from '@/track';
import { getRuntimeTokenStore, startTokenStore, stopTokenStore } from '@/auth/tokenStoreRuntime';
import { withTimeout } from '@/auth/tokenStore';
import { wipeLocalSessionAndReload } from '@/auth/logout';

const LOGOUT_STEP_TIMEOUT_MS = 5_000;

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (credentials: AuthCredentials) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout } : null);
    }, [isAuthenticated, credentials]);

    const login = async (newCredentials: AuthCredentials) => {
        // Fence any previous store first: on native its refresh writes without a
        // compare-and-set and could overwrite the credentials saved below.
        await stopTokenStore();
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) {
            throw new Error('Failed to save credentials');
        }
        await startTokenStore(newCredentials);
        await syncCreate(newCredentials);
        setCredentials(newCredentials);
        setIsAuthenticated(true);
    };

    const logout = async () => {
        trackLogout();
        const registeredPushToken = credentials ? loadRegisteredPushToken() : null;
        if (credentials && registeredPushToken) {
            try {
                await withTimeout(unregisterPushToken(credentials, registeredPushToken), LOGOUT_STEP_TIMEOUT_MS);
            } catch (error) {
                console.log('Failed to unregister push token during logout:', error instanceof Error ? error.message : 'unknown error');
            }
        }
        // Revokes this device on the server (best-effort), then fences any in-flight
        // refresh so it cannot write credentials back after the wipe.
        await getRuntimeTokenStore()?.logoutOnServer(LOGOUT_STEP_TIMEOUT_MS);
        await stopTokenStore();
        setCredentials(null);
        setIsAuthenticated(false);
        await wipeLocalSessionAndReload();
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
