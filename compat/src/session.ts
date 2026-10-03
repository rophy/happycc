/** Starting agent sessions on the cli device and talking to them from the app device. */
import { AGENTS, type AgentId } from './agents';
import { KnownBugSymptom } from './knownBug';
import { agentJson, exec, execDetached, poll, shellQuote } from './stack';

type Session = { id: string; active: boolean; createdAt: number; metadata?: { machineId?: string; host?: string } };

/**
 * The machine id of the cli device, read from its own settings. Matching `machines --json` by host is ambiguous:
 * re-signing in the same container registers a new machine with the same host name.
 */
export async function cliMachineId(): Promise<string> {
    const { stdout } = await exec('cli', 'cat "$HOME/.happycc/settings.json"');
    const machineId = (JSON.parse(stdout) as { machineId?: string }).machineId;
    if (!machineId) throw new Error('The cli device has no machineId in ~/.happycc/settings.json');
    return machineId;
}

export async function startDetached(agent: AgentId, logFile: string): Promise<void> {
    await execDetached('cli', `cd /workspace && exec ${AGENTS[agent].start} > ${shellQuote(logFile)} 2>&1 < /dev/null`);
}

export async function newestSessionSince(sinceMs: number): Promise<string> {
    const machineId = await cliMachineId();
    return poll(async () => {
        const sessions = await agentJson<Session[]>('list --active');
        return sessions
            .filter((s) => s.active && s.createdAt >= sinceMs && s.metadata?.machineId === machineId)
            .sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
    }, { timeoutMs: 60_000, what: 'the new session to appear' });
}

export async function startSession(agent: AgentId, logFile: string): Promise<string> {
    const since = Date.now() - 1000;
    await startDetached(agent, logFile);
    return newestSessionSince(since);
}

/**
 * Send a message and wait for the turn it starts to end (`send --wait` waits for the turn-end event).
 * `send` followed by `wait` is not equivalent: `wait` only waits for "no pending permission requests",
 * which is already true before the agent has even picked the message up.
 */
export async function sendAndWait(sessionId: string, text: string, timeoutS = 120): Promise<void> {
    await exec('app', `timeout ${timeoutS} happycc-agent send --wait ${shellQuote(sessionId)} ${shellQuote(text)}`,
        { timeoutMs: (timeoutS + 30) * 1000 });
}

export async function historyText(sessionId: string): Promise<string> {
    return JSON.stringify(await agentJson<unknown>(`history ${shellQuote(sessionId)}`));
}

export async function stopSession(sessionId: string): Promise<void> {
    await exec('app', `happycc-agent stop ${shellQuote(sessionId)}`);
}

/** Kill leftover agent runners (never the daemon) so scenarios don't leak into each other. */
export async function cleanupAgentProcesses(): Promise<void> {
    // Runners show up as `node …/happycc/dist/index.mjs acp …` (or `… claude --happy-starting-mode …` when the daemon
    // spawned or resumed them), not as `happycc acp …`; the daemon is `… index.mjs daemon start-sync` and never matches.
    // The `[x]` keeps each pattern from matching the `sh -lc` running pkill, which would otherwise kill itself.
    await exec('cli', 'pkill -f "[h]appycc(/dist/index\\.mjs)? (claude |acp|--happy-starting-mode)"; pkill -f "[o]pencode acp"; pkill -f "[p]i-acp"; true',
        { allowFail: true });
}

const turnEnds = (history: string) => history.split('"t":"turn-end"').length - 1;

export async function turnEndCount(sessionId: string): Promise<number> {
    return turnEnds(await historyText(sessionId));
}

/**
 * Wait until the history holds more than `after` turn-end events.
 * With `symptom`, a timeout while `evidence` is already in the history (the agent answered but never closed the
 * turn) is reported as that bug's `KnownBugSymptom`; without the evidence it is a plain timeout.
 */
export async function awaitTurnEnd(sessionId: string, after: number, timeoutS = 60, symptom?: { bug: number; evidence: string }): Promise<void> {
    try {
        await poll(async () => ((await turnEndCount(sessionId)) > after ? true : undefined),
            { timeoutMs: timeoutS * 1000, what: `a turn-end after #${after} in the history of ${sessionId}` });
    } catch (error) {
        if (symptom && (await historyText(sessionId)).includes(symptom.evidence)) {
            throw new KnownBugSymptom(symptom.bug, `"${symptom.evidence}" is in the history but no turn-end followed within ${timeoutS}s`);
        }
        throw error;
    }
}

/**
 * Run one throw-away turn so that later turns are not "the first turn of the session" (CAPABILITIES.md bug 1).
 * Waits for the reply, then gives the turn 15 s to end; a missing turn-end is tolerated here because the
 * round-trip cell is where it is asserted. Returns the number of turn-end events to pass to `awaitTurnEnd`.
 */
export async function warmUp(sessionId: string): Promise<number> {
    await exec('app', `happycc-agent send ${shellQuote(sessionId)} 'compat:hello'`);
    await poll(async () => ((await historyText(sessionId)).includes('COMPAT-HELLO-OK') ? true : undefined),
        { timeoutMs: 60_000, what: 'the warm-up reply' });
    await awaitTurnEnd(sessionId, 0, 15).catch(() => {});
    return turnEndCount(sessionId);
}

/** The pid of the runner process behind a session (`metadata.hostPid`), read while the session is still listed. */
export async function runnerPid(sessionId: string): Promise<number> {
    const sessions = await agentJson<Array<{ id: string; metadata?: { hostPid?: number } }>>('list');
    const pid = sessions.find((s) => s.id === sessionId)?.metadata?.hostPid;
    if (!pid) throw new Error(`Session ${sessionId} has no metadata.hostPid`);
    return pid;
}

/** True while the pid exists on the cli device and is not a zombie. */
export async function pidAlive(pid: number): Promise<boolean> {
    const { stdout } = await exec('cli', `ps -o stat= -p ${pid}`, { allowFail: true });
    const stat = stdout.trim();
    return stat !== '' && !stat.startsWith('Z');
}

export async function sessionActive(sessionId: string): Promise<boolean> {
    return (await agentJson<{ active: boolean }>(`status ${shellQuote(sessionId)}`)).active;
}
