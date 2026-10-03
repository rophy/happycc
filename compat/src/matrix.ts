import { it } from 'vitest';
import { AGENTS, type AgentId, type Scenario } from './agents';
import { runKnownBug } from './knownBug';

/**
 * Register one test per agent for a scenario.
 * - N/A cells (`unsupported`) are skipped with the reason in the title.
 * - Known-bug cells (`knownBugs`) are normal tests whose body asserts the correct behaviour and throws a
 *   `KnownBugSymptom` where the documented bug manifests. They pass while that symptom occurs, fail on any
 *   other error, and fail when the body succeeds (the bug is fixed). See `runKnownBug`.
 */
export function forEachAgent(scenario: Scenario, body: (agent: AgentId) => Promise<void>): void {
    for (const agent of Object.keys(AGENTS) as AgentId[]) {
        const def = AGENTS[agent];
        const reason = def.unsupported[scenario];
        const bug = def.knownBugs?.[scenario];
        if (reason) it.skip(`${agent} › ${scenario} (N/A: ${reason})`, () => {});
        else if (bug) it(`${agent} › ${scenario} (known bug ${bug})`, () => runKnownBug(bug, () => body(agent)));
        else it(`${agent} › ${scenario}`, () => body(agent));
    }
}
