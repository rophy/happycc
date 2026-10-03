import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { startSession, sendAndWait, historyText, stopSession, cleanupAgentProcesses, awaitTurnEnd, warmUp } from '../src/session';
import { agentJson, exec, poll, shellQuote } from '../src/stack';

type Request = { id: string; tool: string };
let sessionId: string | undefined;

afterEach(async () => {
    if (sessionId) await stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    await cleanupAgentProcesses();
});

async function pendingRequest(id: string): Promise<Request> {
    return poll(async () => (await agentJson<Request[]>(`permissions ${shellQuote(id)}`))[0],
        { timeoutMs: 60_000, what: 'a permission request' });
}

const fileExists = async () => (await exec('cli', 'test -e /workspace/compat-write.txt', { allowFail: true })).code === 0;

describe('conversation', () => {
    // The first turn of a session: the reply must be followed by turn-end (Claude: bug 1).
    forEachAgent('roundtrip', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-roundtrip.log`);
        await exec('app', `happycc-agent send ${shellQuote(sessionId)} 'compat:hello'`);
        await awaitTurnEnd(sessionId, 0, 60, { bug: 1, evidence: 'COMPAT-HELLO-OK' });
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });

    forEachAgent('tool-allow', async (agent) => {
        await exec('cli', 'rm -f /workspace/compat-write.txt');
        sessionId = await startSession(agent, `/tmp/compat-${agent}-tool-allow.log`);
        const before = await warmUp(sessionId);
        await exec('app', `happycc-agent send ${shellQuote(sessionId)} "compat:write"`);
        const request = await pendingRequest(sessionId);
        await exec('app', `happycc-agent approve ${shellQuote(sessionId)} ${shellQuote(request.id)}`);
        await awaitTurnEnd(sessionId, before, 60);
        expect((await exec('cli', 'cat /workspace/compat-write.txt')).stdout).toBe('COMPAT-FILE-CONTENT');
        expect(await historyText(sessionId)).toContain('COMPAT-WRITE-DONE');
    });

    forEachAgent('tool-deny', async (agent) => {
        await exec('cli', 'rm -f /workspace/compat-write.txt');
        sessionId = await startSession(agent, `/tmp/compat-${agent}-tool-deny.log`);
        const before = await warmUp(sessionId);
        await exec('app', `happycc-agent send ${shellQuote(sessionId)} "compat:write"`);
        const request = await pendingRequest(sessionId);
        await exec('app', `happycc-agent deny ${shellQuote(sessionId)} ${shellQuote(request.id)}`);
        expect(await fileExists()).toBe(false);
        await poll(async () => (JSON.stringify(await agentJson<unknown>(`status ${shellQuote(sessionId!)}`)).includes('"status":"denied"') ? true : undefined),
            { timeoutMs: 15_000, what: 'the request to be recorded as denied' });
        // Claude (bug 2): after a deny the turn stays open. The write turn only counts as closed by a new turn-end.
        await awaitTurnEnd(sessionId, before, 30, { bug: 2, evidence: request.id });
        expect(await fileExists()).toBe(false);
        await sendAndWait(sessionId, 'compat:hello', 60);
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });
});
