import { describe, expect, it } from 'vitest';
import { KnownBugSymptom, bugNumber, runKnownBug } from './knownBug';

describe('runKnownBug', () => {
    it('passes when the body throws the symptom of the same bug', async () => {
        await expect(runKnownBug('#2: x', async () => { throw new KnownBugSymptom(2, 'turn open'); })).resolves.toBeUndefined();
    });
    it('rethrows the symptom of a different bug', async () => {
        await expect(runKnownBug('#2: x', async () => { throw new KnownBugSymptom(1, 'no turn-end'); })).rejects.toThrow('known bug #1 symptom');
    });
    it('rethrows any other error', async () => {
        await expect(runKnownBug('#1: x', async () => { throw new Error('exec failed'); })).rejects.toThrow('exec failed');
    });
    it('fails when the body succeeds', async () => {
        await expect(runKnownBug('#3: x', async () => {})).rejects.toThrow('known bug #3 no longer reproduces — update compat/src/agents.ts knownBugs and CAPABILITIES.md');
    });
    it('parses the bug number and rejects malformed labels', () => {
        expect(bugNumber('#12: y')).toBe(12);
        expect(() => bugNumber('bug 1')).toThrow('must start with');
    });
});
