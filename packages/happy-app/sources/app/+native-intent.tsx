import { isAuthCallbackPath } from '@/auth/callbackUrls';

/**
 * The sign-in auth session consumes `<scheme>://auth/callback?code=…` itself
 * (sources/auth/signIn.ts). If the OS also hands that link to the router
 * (Android Custom Tabs), stay on the home screen instead of opening a route.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    return isAuthCallbackPath(path) ? '/' : path;
}
