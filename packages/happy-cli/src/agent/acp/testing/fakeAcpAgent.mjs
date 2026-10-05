// A minimal ACP agent for AcpBackend tests. The prompt text picks the turn's shape:
//   "pause"  — three text chunks with PAUSE_MS between them
//   "tool"   — a tool call that completes, then a pause, then text
//   "silent" — no output at all
// Every turn ends with the session/prompt response (stopReason end_turn), as ACP specifies.
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const PAUSE_MS = Number(process.env.FAKE_ACP_PAUSE_MS ?? 700);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

new AgentSideConnection((conn) => {
    const text = (sessionId, chunk) => conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
    });
    return {
        async initialize() {
            return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
        },
        async newSession() {
            return { sessionId: 'fake-session' };
        },
        async authenticate() {
            return {};
        },
        async prompt(params) {
            const kind = params.prompt.map((block) => block.text ?? '').join('');
            if (kind === 'pause') {
                for (const chunk of ['one ', 'two ', 'three']) {
                    await text(params.sessionId, chunk);
                    await sleep(PAUSE_MS);
                }
            } else if (kind === 'tool') {
                await conn.sessionUpdate({
                    sessionId: params.sessionId,
                    update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'look', kind: 'read', status: 'pending' },
                });
                await conn.sessionUpdate({
                    sessionId: params.sessionId,
                    update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
                });
                await sleep(PAUSE_MS);
                await text(params.sessionId, 'done');
            }
            return { stopReason: 'end_turn' };
        },
        async cancel() {},
    };
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
