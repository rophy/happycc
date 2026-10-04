import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { KnownBugSymptom } from '../src/knownBug';
import {
    startSession, startDetached, newestSessionSince, sendAndWait, historyText, stopSession, killSession, cleanupAgentProcesses,
    warmUp, turnEndCount, runnerPid, pidAlive, sessionActive,
} from '../src/session';
import { agentJson, compose, exec, execDetached, poll, shellQuote } from '../src/stack';

let sessionId: string | undefined;

afterEach(async () => {
    if (sessionId) await stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    try {
        await compose('start server');
    } finally {
        await cleanupAgentProcesses();
    }
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
        // whole text only once the reply is complete.)
        await poll(async () => ((await historyText(id)).includes('"text":"compat:slow"') ? true : undefined),
            { timeoutMs: 30_000, what: 'the slow message to reach the session' });
        await new Promise((r) => setTimeout(r, 5000));
        await exec('app', `happycc-agent abort ${shellQuote(id)}`);
        // The abort took effect and left no turn open. OpenCode and Pi open a turn when the prompt is sent, so the
        // abort ends it; Claude Code opens one only on its first output, so an abort before any output ends no turn
        // and only reports "Aborted by user".
        const count = (history: string, t: string) => history.split(`"t":"${t}"`).length - 1;
        try {
            await poll(async () => {
                const history = await historyText(id);
                const settled = count(history, 'turn-end') > before || history.includes('Aborted by user');
                return settled && count(history, 'turn-start') === count(history, 'turn-end') ? true : undefined;
            }, { timeoutMs: 30_000, what: `the abort to end the slow turn of ${id}` });
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

    // Kill, as the app does it (the killSession session RPC): the runner exits and the session ends.
    forEachAgent('kill', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-kill.log`);
        const id = sessionId;
        const pid = await runnerPid(id);
        await warmUp(id);
        expect(await pidAlive(pid)).toBe(true);
        await killSession(id);
        await poll(async () => ((await pidAlive(pid)) ? undefined : true),
            { timeoutMs: 30_000, what: `runner ${pid} to exit` });
        await poll(async () => ((await sessionActive(id)) ? undefined : true),
            { timeoutMs: 30_000, what: `session ${id} to report inactive` });
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

    // Workstation resume: the terminal process ends, `happycc resume <id>` in a terminal reattaches to the same
    // session (history kept) and the app can talk to it again. No daemon is involved.
    forEachAgent('workstation-resume', async (agent) => {
        sessionId = await startSession(agent, `/tmp/compat-${agent}-workstation-resume.log`);
        const id = sessionId;
        await warmUp(id);
        const pid = await runnerPid(id);
        await exec('cli', `kill ${pid}`);
        await poll(async () => ((await sessionActive(id)) ? undefined : true),
            { timeoutMs: 30_000, what: `session ${id} to report inactive` });

        // Claude Code: continue the conversation outside happycc first; resume must bring these to the app (slopus/happy#1861).
        const claudeSessionId = agent === 'claude'
            ? (await agentJson<{ metadata?: { claudeSessionId?: string } }>(`status ${shellQuote(id)}`)).metadata?.claudeSessionId
            : undefined;
        if (agent === 'claude') {
            if (!claudeSessionId) throw new Error(`Session ${id} has no metadata.claudeSessionId`);
            for (const text of ['outside message one', 'outside message two']) {
                await exec('cli', `cd /workspace && claude -p --resume ${shellQuote(claudeSessionId)} ${shellQuote(text)}`, { timeoutMs: 120_000 });
            }
        }

        // Claude Code resumes in its terminal mode, so it needs a TTY: `script` provides one.
        await execDetached('cli', `cd /workspace && exec script -qfc ${shellQuote(`happycc resume ${id}`)} /tmp/compat-${agent}-resumed.log < /dev/null > /dev/null 2>&1`);
        await poll(async () => ((await sessionActive(id)) ? true : undefined),
            { timeoutMs: 60_000, what: `session ${id} to be active again` });
        await exec('app', `happycc-agent send ${shellQuote(id)} 'compat:hello'`);
        await poll(async () => ((await historyText(id)).split('COMPAT-HELLO-OK').length - 1 >= 2 ? true : undefined),
            { timeoutMs: 90_000, what: 'a reply from the resumed session next to the earlier one' });
        const history = await historyText(id);
        const count = (needle: string) => history.split(needle).length - 1;
        // Nothing from before the stop is sent twice.
        expect(count('COMPAT-HELLO-OK')).toBe(2);
        if (agent === 'claude') {
            expect(count('"text":"outside message one"')).toBe(1);
            expect(count('"text":"outside message two"')).toBe(1);
            expect(count('This is a mocked reply')).toBe(2);
        }
    });
});
