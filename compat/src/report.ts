/**
 * Renders the compatibility matrix (markdown) from vitest's JSON results and the pinned versions.
 * Run directly by `npm run report` via Node's type stripping, so it imports no sibling modules.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type VitestJson = { testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> };

const AGENTS: Array<[id: string, label: string]> = [['claude', 'Claude Code'], ['opencode', 'OpenCode'], ['pi', 'Pi']];
const SCENARIOS = ['roundtrip', 'tool-allow', 'tool-deny', 'abort', 'kill', 'offline-start', 'resume', 'spawn'];

type Cell = { text: string; kind: 'pass' | 'na' | 'bug' | 'fail' };

function parseTitle(title: string): { agent: string; scenario: string; na?: string; bug?: { n: number; text: string } } | undefined {
    const m = title.match(/^(\S+) › (\S+?)(?: \((N\/A: |known bug )([\s\S]*)\))?$/);
    if (!m) return undefined;
    const [, agent, scenario, kind, detail] = m;
    if (kind === 'N/A: ') return { agent, scenario, na: detail };
    if (kind === 'known bug ') {
        const n = detail.match(/^#(\d+)/);
        return n ? { agent, scenario, bug: { n: Number(n[1]), text: detail } } : { agent, scenario };
    }
    return { agent, scenario };
}

export function renderMatrix(results: VitestJson, versions: Record<string, string>): string {
    const cells = new Map<string, Cell>();
    const naNotes = new Set<string>();
    const bugNotes = new Map<number, string>();
    for (const file of results.testResults) {
        for (const test of file.assertionResults) {
            const p = parseTitle(test.title);
            if (!p) continue;
            let cell: Cell;
            if (test.status === 'failed') cell = { text: '⚠️ FAILED', kind: 'fail' };
            else if (p.na !== undefined) {
                cell = { text: 'N/A', kind: 'na' };
                naNotes.add(p.na);
            } else if (p.bug && test.status === 'passed') {
                cell = { text: `❌ #${p.bug.n}`, kind: 'bug' };
                bugNotes.set(p.bug.n, p.bug.text);
            } else if (test.status === 'passed') cell = { text: '✅', kind: 'pass' };
            else continue;
            cells.set(`${p.agent}/${p.scenario}`, cell);
        }
    }
    const count = (kind: Cell['kind']) => [...cells.values()].filter(c => c.kind === kind).length;

    const lines = [
        '# Agent compatibility',
        '',
        `${count('pass')} ✅ passed, ${count('na')} N/A, ${count('bug')} ❌ known bugs, ${count('fail')} ⚠️ FAILED.`,
        '`❌ #n` cells are known product bugs: expected while the bug exists, and the suite still exits 0. `⚠️ FAILED` cells (including a known bug that no longer reproduces) fail the run.',
        '',
        `| Scenario | ${AGENTS.map(a => a[1]).join(' | ')} |`,
        `| --- | ${AGENTS.map(() => '---').join(' | ')} |`,
    ];
    for (const scenario of SCENARIOS) {
        lines.push(`| ${scenario} | ${AGENTS.map(([id]) => cells.get(`${id}/${scenario}`)?.text ?? '—').join(' | ')} |`);
    }
    if (naNotes.size) {
        lines.push('', '**N/A** (evidence in `CAPABILITIES.md`):', '', ...[...naNotes].map(r => `- ${r}`));
    }
    if (bugNotes.size) {
        lines.push('', '**Known bugs** (see "Bugs found" in `CAPABILITIES.md`):', '', ...[...bugNotes].sort((a, b) => a[0] - b[0]).map(([, text]) => `- ${text}`));
    }
    lines.push('', '## Versions', '', ...Object.entries(versions).map(([k, v]) => `- ${k}: ${v}`), '');
    return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const results = JSON.parse(readFileSync('results.json', 'utf8')) as VitestJson;
    const versions = JSON.parse(readFileSync('.versions.json', 'utf8')) as Record<string, string>;
    const md = renderMatrix(results, versions);
    writeFileSync('report.md', md);
    console.log(md);
}
