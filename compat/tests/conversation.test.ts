import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { startSession, sendAndWait, historyText, stopSession, cleanupAgentProcesses, waitForTurnEnd } from '../src/session';
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

describe('conversation', () => {
    forEachAgent('roundtrip', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-roundtrip.log`);
        await sendAndWait(sessionId, 'compat:hello', 60);
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });

    forEachAgent('tool-allow', async (agent) => {
        await exec('cli', 'rm -f /workspace/compat-write.txt');
        sessionId = await startSession(agent, `/tmp/compat-${agent}-tool-allow.log`);
        await exec('app', `happycc-agent send ${shellQuote(sessionId)} "compat:write"`);
        const request = await pendingRequest(sessionId);
        await exec('app', `happycc-agent approve ${shellQuote(sessionId)} ${shellQuote(request.id)}`);
        await waitForTurnEnd(sessionId, 1, 60);
        expect((await exec('cli', 'cat /workspace/compat-write.txt')).stdout).toBe('COMPAT-FILE-CONTENT');
        expect(await historyText(sessionId)).toContain('COMPAT-WRITE-DONE');
    });

    forEachAgent('tool-deny', async (agent) => {
        await exec('cli', 'rm -f /workspace/compat-write.txt');
        sessionId = await startSession(agent, `/tmp/compat-${agent}-tool-deny.log`);
        await exec('app', `happycc-agent send ${shellQuote(sessionId)} "compat:write"`);
        const request = await pendingRequest(sessionId);
        await exec('app', `happycc-agent deny ${shellQuote(sessionId)} ${shellQuote(request.id)}`);
        await waitForTurnEnd(sessionId, 1, 60);
        expect((await exec('cli', 'test -e /workspace/compat-write.txt', { allowFail: true })).code).not.toBe(0);
        await sendAndWait(sessionId, 'compat:hello', 60);
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });
});
