import { MMKV } from 'react-native-mmkv';
import { resolveServerUrl } from './serverUrl';

// Device-local developer settings that persist across logouts (remote log server).
const serverConfigStorage = new MMKV({ id: 'server-config' });

const LOG_SERVER_KEY = 'log-server-url';

// Upstream let users override the server URL; the corporate fork has no picker.
// Drop any override an older build stored so it can never be read again.
serverConfigStorage.delete('custom-server-url');
serverConfigStorage.delete('use-custom-server-for-voice');

/** Deploy-time `window.__HAPPY_CONFIG__.serverUrl`, else build-time EXPO_PUBLIC_HAPPY_SERVER_URL. */
export function getServerUrl(): string {
    // happy-mobile-gym harness: pin the run to its explicit loopback server.
    // Production ignores this path.
    if (__DEV__ && process.env.EXPO_PUBLIC_HARNESS_MODE === '1') {
        const configured = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        if (!configured) throw new Error('Harness startup requires its explicit server URL.');
        const parsed = new URL(configured);
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)
            || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
            throw new Error('Harness startup requires a plain loopback HTTP origin.');
        }
        return parsed.origin;
    }
    return resolveServerUrl({
        deployUrl: (globalThis as any).__HAPPY_CONFIG__?.serverUrl,
        buildUrl: process.env.EXPO_PUBLIC_HAPPY_SERVER_URL,
    });
}

export function rewriteLoopbackHost(url: string): string {
    try {
        const target = new URL(url);
        if (target.hostname !== 'localhost' && target.hostname !== '127.0.0.1' && target.hostname !== '::1') {
            return url;
        }
        const reachable = new URL(getServerUrl());
        target.protocol = reachable.protocol;
        target.host = reachable.host;
        return target.toString();
    } catch {
        return url;
    }
}

export function getLogServerUrl(): string | null {
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function getServerInfo(): { hostname: string; port?: number } {
    const url = getServerUrl();
    try {
        const parsed = new URL(url);
        return { hostname: parsed.hostname, port: parsed.port ? parseInt(parsed.port) : undefined };
    } catch {
        return { hostname: url, port: undefined };
    }
}

/** `host[:port]` of the configured server, for headers and settings rows. */
export function getServerLabel(): string {
    const info = getServerInfo();
    return info.hostname + (info.port ? `:${info.port}` : '');
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
