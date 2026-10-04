import { describe, expect, it } from 'vitest';
import { renderMatrix, type VitestJson } from './report';

const t = (title: string, status: string) => ({ title, status });
const results = (tests: Array<{ title: string; status: string }>): VitestJson => ({ testResults: [{ assertionResults: tests }] });
const versions = { happycc: '1.2.5', claude: '2.1.288' };

describe('renderMatrix', () => {
    const md = renderMatrix(results([
        t('claude › roundtrip', 'passed'),
        t('opencode › spawn (N/A: The daemon cannot spawn ACP agents yet.)', 'skipped'),
        t('pi › spawn (N/A: The daemon cannot spawn ACP agents yet.)', 'skipped'),
        t('claude › tool-deny (known bug #2: denying a permission leaves the turn open)', 'passed'),
        t('pi › abort', 'failed'),
        t('opencode › abort (known bug #4: aborting mid-reply crashes the ACP runner)', 'failed'),
    ]), versions);

    it('renders a header row with agent labels and scenario rows in order', () => {
        expect(md).toContain('| Scenario | Claude Code | OpenCode | Pi |');
        const rows = md.split('\n').filter(l => /^\| (roundtrip|tool-allow|tool-deny|abort|kill|blocked-spawn|blocked-shell|offline-start|workstation-resume|resume|spawn) /.test(l));
        expect(rows.map(r => r.split(' ')[1])).toEqual(['roundtrip', 'tool-allow', 'tool-deny', 'abort', 'kill', 'blocked-spawn', 'blocked-shell', 'offline-start', 'workstation-resume', 'resume', 'spawn']);
    });
    it('renders each cell state', () => {
        expect(md).toContain('| roundtrip | ✅ | — | — |');
        expect(md).toContain('| tool-deny | ❌ #2 | — | — |');
        expect(md).toContain('| abort | — | ⚠️ FAILED | ⚠️ FAILED |');
        expect(md).toContain('| spawn | — | N/A | N/A |');
    });
    it('footnotes each N/A reason and bug text once', () => {
        expect(md.match(/The daemon cannot spawn ACP agents yet\./g)).toHaveLength(1);
        expect(md.match(/denying a permission leaves the turn open/g)).toHaveLength(1);
        expect(md).toContain('CAPABILITIES.md');
    });
    it('states counts per state in the top line', () => {
        expect(md.split('\n').find(l => l.includes('✅'))).toContain('1 ✅');
        expect(md).toContain('1 ✅ passed, 2 N/A, 1 ❌ known bugs, 2 ⚠️ FAILED');
        expect(md).toContain('fail the run');
    });
    it('lists versions', () => {
        expect(md).toContain('- happycc: 1.2.5');
        expect(md).toContain('- claude: 2.1.288');
    });
    it('shows no version warning when the bundled Claude Code matches the pin', () => {
        expect(renderMatrix(results([]), { claude: '2.1.288', claudeSdk: '2.1.288' })).not.toContain('mismatch');
        expect(md).not.toContain('mismatch');
    });
    it('flags a bundled Claude Code that differs from the pin', () => {
        const out = renderMatrix(results([]), { claude: '2.1.288', claudeSdk: '2.1.300' });
        const lines = out.split('\n');
        expect(lines[2]).toBe("⚠️ Claude Code version mismatch: remote mode ran 2.1.300 (bundled with happycc's claude-agent-sdk), not the pinned `claude` 2.1.288.");
        expect(out).toContain('- claudeSdk: 2.1.300');
    });
    it('ignores tests that are not matrix cells', () => {
        expect(renderMatrix(results([t('runKnownBug passes when x', 'passed')]), {})).toContain('0 ✅ passed');
    });
});
