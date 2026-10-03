import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { KnownBugSymptom } from '../src/knownBug';
import {
    startSession, startDetached, newestSessionSince, sendAndWait, historyText, stopSession, cleanupAgentProcesses,
    awaitTurnEnd, warmUp, turnEndCount, runnerPid, pidAlive, sessionActive,
} from '../src/session';
import { compose, exec, poll, shellQuote } from '../src/stack';

let sessionId: string | undefined;

afterEach(async () => {
    if (sessionId) await stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    await compose('start server');
    await cleanupAgentProcesses();
});

describe('lifecycle', () => {
    // Abort mid-reply: the turn ends without the full reply and the session stays usable (ACP agents: bug 4).
    forEachAgent('abort', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-abort.log`);
        const id = sessionId;
        const pid = await runnerPid(id);
        const before = await warmUp(id);
        await exec('app', `happycc-agent send ${shellQuote(id)} 'compat:slow'`);
        // Let the slow reply stream for a few seconds. (The reply text itself is no "started" signal: Pi delivers the
        // whole text only once the reply is complete, and Claude's first turn emits no new turn-start, bug 1.)
        await poll(async () => ((await historyText(id)).includes('"text":"compat:slow"') ? true : undefined),
            { timeoutMs: 30_000, what: 'the slow message to reach the session' });
        await new Promise((r) => setTimeout(r, 5000));
        await exec('app', `happycc-agent abort ${shellQuote(id)}`);
        try {
            await awaitTurnEnd(id, before, 30);
        } catch (error) {
            if (!(await pidAlive(pid)) && await sessionActive(id)) {
                throw new KnownBugSymptom(4, `after abort no turn-end followed, the runner process ${pid} is dead and the session is still active`);
            }
            throw error;
        }
        expect(await historyText(id)).not.toContain('COMPAT-SLOW-END');
        const afterAbort = await turnEndCount(id);
        await sendAndWait(id, 'compat:hello', 60);
        expect(await turnEndCount(id)).toBeGreaterThan(afterAbort);
        expect(await historyText(id)).toContain('COMPAT-HELLO-OK');
    });

    // Kill: the runner exits and the session ends (all agents: bug 3, `stop` only sends session-end).
    forEachAgent('kill', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-kill.log`);
        const id = sessionId;
        const pid = await runnerPid(id);
        await warmUp(id);
        expect(await pidAlive(pid)).toBe(true);
        await stopSession(id);
        const exited = await poll(async () => ((await pidAlive(pid)) ? undefined : true),
            { timeoutMs: 30_000, what: `runner ${pid} to exit` }).catch(() => false);
        if (!exited) {
            throw new KnownBugSymptom(3, `stop succeeded (session active=${await sessionActive(id)}) but runner process ${pid} is still alive after 30s`);
        }
        expect(await sessionActive(id)).toBe(false);
        sessionId = undefined;
    });

    // Offline start: the CLI starts while the server is down, reconnects when it returns, and serves the session.
    forEachAgent('offline-start', async (agent) => {
        await compose('stop server');
        const log = `/tmp/compat-${agent}-offline.log`;
        await exec('cli', `rm -f ${log}`);
        const startedAt = Date.now() - 1000;
        await startDetached(agent, log);
        await poll(async () => ((await exec('cli', `cat ${log}`, { allowFail: true })).stdout.includes('offline mode') ? true : undefined),
            { timeoutMs: 30_000, what: 'the CLI to report offline mode' });
        await compose('start server');
        try {
            await poll(async () => ((await exec('cli', `cat ${log}`)).stdout.includes('Reconnected') ? true : undefined),
                { timeoutMs: 60_000, what: 'the CLI to reconnect' });
        } catch (error) {
            throw new Error(`${String(error)}\n--- CLI log ---\n${(await exec('cli', `cat ${log}`, { allowFail: true })).stdout}`);
        }
        sessionId = await newestSessionSince(startedAt);
        await sendAndWait(sessionId, 'compat:hello', 60);
        expect(await historyText(sessionId)).toContain('COMPAT-HELLO-OK');
    });
});
