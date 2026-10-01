import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectResumeSupport, hasLocalHappyAgentAuth, readLocalHappyAgentCredentials } from './localHappyAgentAuth';

const rawSecret = Buffer.alloc(32, 7);
const secret = rawSecret.toString('base64');
let home: string;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'happy-agent-key-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('local happy-agent credentials', () => {
    it('reads the OIDC agent.key format', () => {
        writeFileSync(join(home, 'agent.key'), JSON.stringify({ token: 'access', refreshToken: 'refresh', secret }));
        const creds = readLocalHappyAgentCredentials(home);
        expect(creds).not.toBeNull();
        expect(Buffer.from(creds!.secret).equals(rawSecret)).toBe(true);
        expect(creds!.contentKeyPair.publicKey).toHaveLength(32);
        expect(hasLocalHappyAgentAuth(home)).toBe(true);
        expect(detectResumeSupport(home)).toMatchObject({ rpcAvailable: true, happyAgentAuthenticated: true });
    });

    it('treats a pre-OIDC agent.key without a refresh token as signed out', () => {
        writeFileSync(join(home, 'agent.key'), JSON.stringify({ token: 'access', secret }));
        expect(readLocalHappyAgentCredentials(home)).toBeNull();
        expect(hasLocalHappyAgentAuth(home)).toBe(false);
        expect(detectResumeSupport(home)).toMatchObject({ rpcAvailable: false, happyAgentAuthenticated: false });
    });

    it('returns null when agent.key is missing', () => {
        expect(readLocalHappyAgentCredentials(home)).toBeNull();
    });
});
