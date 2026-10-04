/**
 * Without a daemon, a session still records its encryption data at start so `happycc resume <id>` can
 * reattach to it on this workstation, and starting does not wait on the missing daemon.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';

const mockConfiguration = vi.hoisted(() => ({
    daemonLockFile: '',
    daemonStateFile: '',
    isDaemonProcess: false,
    logsDir: '/tmp',
    sessionsFile: '',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

import { notifyDaemonSessionStarted } from './controlClient';
import { resolveLocalReconnectableSession } from '@/resume/localResumeStore';

describe('session start without a daemon', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'happycc-session-record-'));
        mockConfiguration.sessionsFile = join(dir, 'sessions.json');
        mockConfiguration.daemonStateFile = join(dir, 'daemon.state.json');
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('records the session for resume and returns without retrying the daemon', async () => {
        const metadata = { path: dir, host: 'h', flavor: 'claude', claudeSessionId: 'c1', hostPid: process.pid } as unknown as Metadata;
        const encryption = {
            encryptionKey: Buffer.alloc(32, 7).toString('base64'),
            encryptionVariant: 'dataKey' as const,
            seq: 3,
            metadataVersion: 2,
            agentStateVersion: 1,
        };

        const started = Date.now();
        const result = await notifyDaemonSessionStarted('s1', metadata, encryption);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(result.error).toMatch(/not available/);

        const resumed = await resolveLocalReconnectableSession('s1');
        expect(resumed).toMatchObject({ id: 's1', encryptionVariant: 'dataKey', seq: 3, metadataVersion: 2, agentStateVersion: 1 });
        expect(resumed.metadata.claudeSessionId).toBe('c1');
    });
});
