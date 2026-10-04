import { afterEach, describe, expect } from 'vitest';
import { forEachAgent } from '../src/matrix';
import { startSession, warmUp, historyText, stopSession, cleanupAgentProcesses, cliMachineId } from '../src/session';
import { exec, shellQuote } from '../src/stack';

let sessionId: string | undefined;

afterEach(async () => {
    if (sessionId) await stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    await cleanupAgentProcesses();
});

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const REFUSED = /not available|not allowed|offline/i;

describe('boundary', () => {
    // With a live session on cli, the app cannot start or resume sessions, and the live session is unaffected.
    forEachAgent('blocked-spawn', async (agent) => {
        const id = (sessionId = await startSession(agent, `/tmp/compat-${agent}-blocked-spawn.log`));
        const machineId = await cliMachineId();

        const spawn = await exec('app', `happycc-agent spawn --machine ${shellQuote(machineId)} --path /workspace --agent claude`,
            { allowFail: true, timeoutMs: 60_000 });
        expect(spawn.code, `spawn output: ${spawn.stdout}${spawn.stderr}`).not.toBe(0);
        expect(`${spawn.stdout}\n${spawn.stderr}`).toMatch(REFUSED);

        const resume = await exec('app', `happycc-agent resume ${shellQuote(id)}`, { allowFail: true, timeoutMs: 60_000 });
        expect(resume.code, `resume output: ${resume.stdout}${resume.stderr}`).not.toBe(0);
        expect(`${resume.stdout}\n${resume.stderr}`).toMatch(REFUSED);

        // warmUp asserts the reply arrives without waiting for turn-end (a session's first turn never gets one, bug 1).
        await warmUp(id);
        expect(occurrences(await historyText(id), 'COMPAT-HELLO-OK')).toBe(1);
    });

    // The app's direct file/shell RPCs run only the listed git commands (happy-wire sessionCommands), never
    // an arbitrary command, a write, or a ripgrep that runs a program.
    forEachAgent('blocked-shell', async (agent) => {
        const id = (sessionId = await startSession(agent, `/tmp/compat-${agent}-blocked-shell.log`));
        const marker = `/tmp/compat-${agent}-blocked-shell-pwned`;
        await exec('cli', `rm -f ${marker}`);
        const rpc = async (method: string, params: unknown) =>
            JSON.parse((await exec('app', `happycc-agent rpc ${shellQuote(id)} ${method} ${shellQuote(JSON.stringify(params))}`,
                { timeoutMs: 60_000 })).stdout.trim());

        expect(await rpc('bash', { command: `touch ${marker}`, cwd: '/workspace' })).toMatchObject({ success: false, error: 'Command not allowed' });
        expect(await rpc('bash', { command: 'happycc --version', cwd: '/' })).toMatchObject({ success: false });
        expect(await rpc('ripgrep', { args: [`--pre=/bin/touch`, '--files'] })).toMatchObject({ success: false });
        expect(await rpc('writeFile', { path: '/workspace/compat-written.txt', content: 'eA==', expectedHash: null })).toMatchObject({ success: false });
        expect((await exec('cli', `test -e ${marker} || test -e /workspace/compat-written.txt`, { allowFail: true })).code).not.toBe(0);

        // A listed command still runs (the app's git badge).
        expect(await rpc('bash', { command: 'git rev-parse --is-inside-work-tree', cwd: '/workspace' })).toHaveProperty('success');
    });
});
