import { describe, expect, it } from 'vitest';
import { forbiddenReason, notAuthorizedMessage } from './forbidden';

describe('forbidden', () => {
    it('recognizes the server forbidden payload', () => {
        expect(forbiddenReason({ error: 'forbidden', reason: 'Ask IT' })).toBe('Ask IT');
        expect(forbiddenReason({ error: 'forbidden' })).toBeNull();
        expect(forbiddenReason({ error: 'other' })).toBeUndefined();
        expect(forbiddenReason(undefined)).toBeUndefined();
    });

    it('builds the message', () => {
        expect(notAuthorizedMessage('Ask IT')).toBe('Not authorized: Ask IT');
        expect(notAuthorizedMessage(null)).toBe('Not authorized: your organization has not given you access.');
    });
});
