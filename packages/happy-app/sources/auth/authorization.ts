import { useSyncExternalStore } from 'react';

/**
 * Whether the server refused this device (authorization webhook): set from a 403
 * `{ error: 'forbidden' }` or the socket's denial, shown by NotAuthorizedGate.
 */
type Forbidden = { reason: string | null };

let current: Forbidden | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

/** The reason of a `{ error: 'forbidden', reason? }` payload, or undefined if `data` is not one. */
export function forbiddenReason(data: unknown): string | null | undefined {
    const value = data as { error?: unknown; reason?: unknown } | null | undefined;
    if (value?.error !== 'forbidden') {
        return undefined;
    }
    return typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : null;
}

export function reportForbidden(reason: string | null): void {
    current = { reason };
    notify();
}

export function clearForbidden(): void {
    current = null;
    notify();
}

export function getForbidden(): Forbidden | null {
    return current;
}

export function subscribeForbidden(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useForbidden(): Forbidden | null {
    return useSyncExternalStore(subscribeForbidden, getForbidden, getForbidden);
}
