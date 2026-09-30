/**
 * Foreground-session bootstrap helper: prints a clear message and runs the
 * caller's own shutdown/cleanup path when credentials are invalidated
 * mid-session (logout from another terminal, admin revocation, a replayed
 * refresh token).
 *
 * Without this, a socket auth callback that rejects with LoggedOutError (see
 * apiMachine.ts / apiSession.ts) had nothing registered to catch it in a
 * foreground session, which surfaced as an uncaughtException and archived
 * the session with no indication of why.
 *
 * The daemon has its own handler (registered in daemon/run.ts) — do not call
 * this for the daemon process, or the session will get shut down twice.
 */
import { tokenStore, type LoggedOutError } from '@/api/tokenStore';

export function registerLoggedOutShutdown(onLoggedOut: (error: LoggedOutError) => void | Promise<void>): () => void {
    return tokenStore.onLoggedOut((error) => {
        console.error(error.message);
        try {
            Promise.resolve(onLoggedOut(error)).catch(() => { });
        } catch { }
    });
}
