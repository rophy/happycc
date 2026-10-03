import { it } from 'vitest';
import { AGENTS, type AgentId, type Scenario } from './agents';

/**
 * Register one test per agent for a scenario.
 * - N/A cells (`unsupported`) are skipped with the reason in the title.
 * - Known-bug cells (`knownBugs`) run as `it.fails`: the body asserts the correct behaviour, so the cell is
 *   expected to fail today and vitest reports it as soon as the bug is fixed.
 */
export function forEachAgent(scenario: Scenario, body: (agent: AgentId) => Promise<void>): void {
    for (const agent of Object.keys(AGENTS) as AgentId[]) {
        const def = AGENTS[agent];
        const reason = def.unsupported[scenario];
        const bug = def.knownBugs?.[scenario];
        if (reason) it.skip(`${agent} › ${scenario} (N/A: ${reason})`, () => {});
        else if (bug) it.fails(`${agent} › ${scenario} (known bug ${bug})`, () => body(agent));
        else it(`${agent} › ${scenario}`, () => body(agent));
    }
}
