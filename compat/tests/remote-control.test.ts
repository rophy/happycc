import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import {
    startSession, sendAndWait, historyText, stopSession, cleanupAgentProcesses,
    warmUp, runnerPid, pidAlive, sessionActive, cliMachineId,
} from '../src/session';
import { agentJson, exec, poll, shellQuote } from '../src/stack';

let sessionIds: string[] = [];

afterEach(async () => {
    for (const id of sessionIds) await stopSession(id).catch(() => {});
    sessionIds = [];
    await cleanupAgentProcesses();
});

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe('remote-control', () => {
    // Resume: after the session's runner dies, the app resumes it on the cli device and earlier history is kept.
    forEachAgent('resume', async (agent) => {
        const first = await startSession(agent, `/tmp/compat-${agent}-resume.log`);
        sessionIds.push(first);
        const pid = await runnerPid(first);
        await warmUp(first); // first reply (and avoids bug 1 for the turn after the resume)
        expect(occurrences(await historyText(first), 'COMPAT-HELLO-OK')).toBe(1);

        await exec('cli', `kill ${pid}`);
        await poll(async () => ((await pidAlive(pid)) ? undefined : true), { timeoutMs: 30_000, what: `runner ${pid} to exit` });
        await poll(async () => ((await sessionActive(first)) ? undefined : true), { timeoutMs: 60_000, what: 'the session to become inactive' });

        const resumed = await agentJson<{ type: string; sessionId?: string }>(`resume ${shellQuote(first)}`);
        expect(resumed.type).toBe('success');
        const id = resumed.sessionId ?? first;
        if (id !== first) sessionIds.push(id);
        // The resumed runner takes ~40 s to report active (measured 35-40 s); its metadata.hostPid is not updated.
        await poll(async () => ((await sessionActive(id)) ? true : undefined), { timeoutMs: 90_000, what: `resumed session ${id} to be active` });

        await sendAndWait(id, 'compat:hello', 60);
        expect(occurrences(await historyText(id), 'COMPAT-HELLO-OK')).toBe(2);
    });

    // Spawn: the app starts a session on the cli device's machine and it answers.
    forEachAgent('spawn', async (agent) => {
        const machineId = await cliMachineId();
        const spawned = await agentJson<{ type: string; sessionId?: string }>(
            `spawn --machine ${shellQuote(machineId)} --path /workspace --agent claude`);
        expect(spawned.type).toBe('success');
        const id = spawned.sessionId!;
        expect(id).toBeTruthy();
        sessionIds.push(id);
        await poll(async () => ((await sessionActive(id)) ? true : undefined), { timeoutMs: 60_000, what: `spawned session ${id} to be active` });
        // The first turn of a session never gets turn-end (bug 1); warm up, then assert on a later turn.
        await warmUp(id);
        await sendAndWait(id, 'compat:hello', 60);
        expect(occurrences(await historyText(id), 'COMPAT-HELLO-OK')).toBe(2);
    });
});
