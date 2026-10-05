import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AcpBackend } from './AcpBackend';
import type { AgentMessage } from '../core/AgentBackend';

const FAKE_AGENT = join(__dirname, 'testing', 'fakeAcpAgent.mjs');

let backend: AcpBackend | null = null;

afterEach(async () => {
    await backend?.dispose();
    backend = null;
});

/** Starts AcpBackend on the fake agent and records the status messages it emits. */
async function start() {
    const statuses: string[] = [];
    backend = new AcpBackend({ agentName: 'fake', cwd: process.cwd(), command: process.execPath, args: [FAKE_AGENT] });
    backend.onMessage((msg: AgentMessage) => {
        if (msg.type === 'status') statuses.push(msg.status);
    });
    const { sessionId } = await backend.startSession();
    statuses.length = 0;
    return { sessionId, statuses };
}

describe('AcpBackend turn end', () => {
    it('stays running through pauses in the reply and goes idle when the prompt completes', async () => {
        const { sessionId, statuses } = await start();
        await backend!.sendPrompt(sessionId, 'pause');
        expect(statuses).toEqual(['running', 'idle']);
    }, 15_000);

    it('stays running when a tool call completes mid-turn', async () => {
        const { sessionId, statuses } = await start();
        await backend!.sendPrompt(sessionId, 'tool');
        expect(statuses.filter((status) => status === 'idle')).toEqual(['idle']);
        expect(statuses.at(-1)).toBe('idle');
    }, 15_000);

    it('goes idle at the end of a turn with no output', async () => {
        const { sessionId, statuses } = await start();
        await backend!.sendPrompt(sessionId, 'silent');
        expect(statuses).toEqual(['running', 'idle']);
        await expect(backend!.waitForResponseComplete(1_000)).resolves.toBeUndefined();
    }, 15_000);
});
