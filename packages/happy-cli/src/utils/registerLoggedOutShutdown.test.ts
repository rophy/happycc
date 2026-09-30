import { describe, expect, it, vi } from 'vitest';

const listeners = vi.hoisted(() => new Set<(error: any) => void>());

vi.mock('@/api/tokenStore', () => ({
    tokenStore: {
        onLoggedOut: (listener: (error: any) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    },
}));

import { registerLoggedOutShutdown } from './registerLoggedOutShutdown';

function fireLoggedOut(error: any) {
    for (const listener of listeners) listener(error);
}

describe('registerLoggedOutShutdown', () => {
    it('prints the error message and runs the caller shutdown path, without throwing', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
        const cleanup = vi.fn();
        registerLoggedOutShutdown(cleanup);

        const error = new Error('Logged out: run "happy auth login" to sign in again');
        expect(() => fireLoggedOut(error)).not.toThrow();

        expect(consoleError).toHaveBeenCalledWith(error.message);
        expect(cleanup).toHaveBeenCalledWith(error);
        consoleError.mockRestore();
        listeners.clear();
    });

    it('does not let a rejecting async cleanup escape as an unhandled rejection', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { });
        const cleanup = vi.fn(async () => { throw new Error('cleanup failed'); });
        registerLoggedOutShutdown(cleanup);

        expect(() => fireLoggedOut(new Error('logged out'))).not.toThrow();
        // Let the rejected promise settle; a global unhandledRejection listener would
        // otherwise be the only way to observe this test failing.
        await new Promise((resolve) => setTimeout(resolve, 0));

        consoleError.mockRestore();
        listeners.clear();
    });
});
