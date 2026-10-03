/** Known-bug cells: the cell passes only while the documented symptom of its bug still occurs. */

/** Thrown only at the exact point a documented product bug (CAPABILITIES.md "Bugs found") manifests. */
export class KnownBugSymptom extends Error {
    constructor(readonly bug: number, message: string) {
        super(`known bug #${bug} symptom: ${message}`);
        this.name = 'KnownBugSymptom';
    }
}

/** `"#2: denying a permission leaves the turn open"` → 2. */
export function bugNumber(label: string): number {
    const n = label.match(/^#(\d+)\b/)?.[1];
    if (!n) throw new Error(`knownBugs value must start with "#<n>": ${JSON.stringify(label)}`);
    return Number(n);
}

/**
 * Run a cell body that asserts the CORRECT behaviour.
 * - throws that body's `KnownBugSymptom` for this bug → pass (the bug is still present);
 * - any other error (harness break, other bug, timeout) → rethrown;
 * - success → fail: the bug no longer reproduces.
 */
export async function runKnownBug(label: string, body: () => Promise<void>): Promise<void> {
    const bug = bugNumber(label);
    try {
        await body();
    } catch (error) {
        if (error instanceof KnownBugSymptom && error.bug === bug) return;
        throw error;
    }
    throw new Error(`known bug #${bug} no longer reproduces — update compat/src/agents.ts knownBugs and CAPABILITIES.md`);
}
