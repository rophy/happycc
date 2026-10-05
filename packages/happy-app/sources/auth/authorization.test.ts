import { describe, expect, it, vi } from 'vitest';
import { clearForbidden, forbiddenReason, getForbidden, reportForbidden, subscribeForbidden } from './authorization';

describe('authorization state', () => {
    it('parses the server forbidden payload', () => {
        expect(forbiddenReason({ error: 'forbidden', reason: 'Ask IT' })).toBe('Ask IT');
        expect(forbiddenReason({ error: 'forbidden' })).toBeNull();
        expect(forbiddenReason({ error: 'nope' })).toBeUndefined();
    });

    it('reports and clears a denial, notifying listeners', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeForbidden(listener);
        reportForbidden('Ask IT');
        expect(getForbidden()).toEqual({ reason: 'Ask IT' });
        clearForbidden();
        expect(getForbidden()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });
});
