export type SessionEventKind = 'done' | 'permission' | 'question';

const TITLES: Record<SessionEventKind, string> = {
    done: "It's ready!",
    permission: 'Permission request',
    question: 'Clarification needed',
};

/** Pushes never carry session titles, paths, tool names or message text. */
export const SESSION_EVENT_PUSH_BODY = 'Open the session to continue.';

export interface SessionEventPush {
    title: string;
    body: string;
    data: { sessionId: string; kind: SessionEventKind; url: string };
}

export function buildSessionEventPush(sessionId: string, kind: SessionEventKind): SessionEventPush {
    return {
        title: TITLES[kind],
        body: SESSION_EVENT_PUSH_BODY,
        data: { sessionId, kind, url: `/session/${encodeURIComponent(sessionId)}` },
    };
}
