import { describe, expect, it } from 'vitest';
import { SESSION_EVENT_PUSH_BODY, buildSessionEventPush } from './pushCopy';

describe('buildSessionEventPush', () => {
    it('uses a fixed title per kind, a generic body and minimal data', () => {
        expect(buildSessionEventPush('sess-1', 'done')).toEqual({
            title: "It's ready!",
            body: SESSION_EVENT_PUSH_BODY,
            data: { sessionId: 'sess-1', kind: 'done', url: '/session/sess-1' },
        });
        expect(buildSessionEventPush('sess-1', 'permission').title).toBe('Permission request');
        expect(buildSessionEventPush('sess-1', 'question').title).toBe('Clarification needed');
        expect(SESSION_EVENT_PUSH_BODY).toBe('Open the session to continue.');
    });

    it('encodes the session id in the url', () => {
        expect(buildSessionEventPush('a/b c', 'done').data.url).toBe('/session/a%2Fb%20c');
    });
});
