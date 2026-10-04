import { describe, expect, it } from 'vitest';
import {
    buildSessionCommand,
    isAllowedRipgrepArgs,
    parseSessionCommand,
    sessionCommandPlan,
    SESSION_RIPGREP_SEARCHES,
    type SessionCommand,
} from './sessionCommands';

const ALL: SessionCommand[] = [
    { kind: 'gitIsRepo' },
    { kind: 'gitStatus', showStash: true },
    { kind: 'gitStatus', showStash: false },
    { kind: 'gitDiffNumstat', cached: false },
    { kind: 'gitDiffNumstat', cached: true },
    { kind: 'gitDiffNumstatBoth' },
    { kind: 'gitLsFiles' },
    { kind: 'gitDiffFile', path: 'src/app.ts' },
    { kind: 'gitDiffHeadFile', path: 'src/app.ts' },
    { kind: 'gitDiffHeadFile', path: 'src/app.ts', contextLines: 100000, ignoreWhitespace: true },
    { kind: 'gitDiffHeadFile', path: 'src/app.ts', contextLines: 0 },
    { kind: 'gitShowHeadBase64', path: 'assets/logo.png' },
    { kind: 'readFile', path: 'notes.txt' },
];

describe('session commands', () => {
    it.each(ALL)('parses back what it builds: %o', (cmd) => {
        expect(parseSessionCommand(buildSessionCommand(cmd))).toEqual(cmd);
    });

    it('builds the strings the app has always sent', () => {
        expect(buildSessionCommand({ kind: 'gitStatus', showStash: true })).toBe(
            'git -c core.quotepath=false status --porcelain=v2 --branch --show-stash --untracked-files=all',
        );
        expect(buildSessionCommand({ kind: 'gitDiffNumstatBoth' })).toBe(
            'git -c core.quotepath=false diff --numstat && echo "---STAGED---" && git -c core.quotepath=false diff --cached --numstat',
        );
        expect(buildSessionCommand({ kind: 'gitDiffHeadFile', path: 'a.ts', contextLines: 25, ignoreWhitespace: true })).toBe(
            'git -c core.quotepath=false diff HEAD --no-ext-diff -U25 -w -- "a.ts"',
        );
        expect(buildSessionCommand({ kind: 'gitShowHeadBase64', path: 'a.png' })).toBe(
            'git -c core.quotepath=false show HEAD:"a.png" | base64',
        );
    });

    it('round-trips paths with shell metacharacters as literal text', () => {
        for (const path of ['a "b".ts', 'x$(touch pwned).ts', 'back`tick`.ts', 'back\\slash.ts', "it's; rm -rf ~.ts"]) {
            const cmd: SessionCommand = { kind: 'gitDiffFile', path };
            expect(parseSessionCommand(buildSessionCommand(cmd))).toEqual(cmd);
            expect(sessionCommandPlan(cmd).steps).toEqual([['git', 'diff', '--no-ext-diff', '--', path]]);
        }
    });

    it.each([
        'happycc',
        'cd /tmp && happycc',
        'git rev-parse --is-inside-work-tree; happycc',
        'git rev-parse --is-inside-work-tree && happycc',
        'git -c core.quotepath=false diff --numstat | sh',
        'git diff --no-ext-diff -- "a" "b"',
        'git diff --no-ext-diff -- "$(happycc)"',
        'git diff --no-ext-diff -- "a`happycc`"',
        'git diff --no-ext-diff -- "a" && happycc',
        'git -c core.quotepath=false diff HEAD --no-ext-diff -U1e9 -- "a"',
        'git -c core.quotepath=false diff HEAD --no-ext-diff --output=/tmp/x -- "a"',
        'git -c core.pager=happycc diff --numstat',
        'cat -- "a" > /tmp/x',
        'cat /etc/passwd',
        ' git rev-parse --is-inside-work-tree',
        'git rev-parse --is-inside-work-tree\nhappycc',
    ])('refuses %j', (command) => {
        expect(parseSessionCommand(command)).toBeNull();
    });

    it('plans the combined numstat as two steps with the staged separator', () => {
        const plan = sessionCommandPlan({ kind: 'gitDiffNumstatBoth' });
        expect(plan.steps).toHaveLength(2);
        expect(plan.separator).toBe('---STAGED---\n');
    });

    it('plans a HEAD read as git show, base64 encoded by the runner', () => {
        expect(sessionCommandPlan({ kind: 'gitShowHeadBase64', path: 'a.png' })).toEqual({
            steps: [['git', '-c', 'core.quotepath=false', 'show', 'HEAD:a.png']],
            output: 'base64',
            paths: ['a.png'],
        });
    });

    it('lists the paths each command touches', () => {
        expect(sessionCommandPlan({ kind: 'readFile', path: '../x' }).paths).toEqual(['../x']);
        expect(sessionCommandPlan({ kind: 'gitStatus', showStash: false }).paths).toEqual([]);
    });
});

describe('ripgrep searches', () => {
    it('allows only the listed argument lists', () => {
        expect(isAllowedRipgrepArgs([...SESSION_RIPGREP_SEARCHES.listFiles])).toBe(true);
        expect(isAllowedRipgrepArgs(['--files'])).toBe(false);
        expect(isAllowedRipgrepArgs(['--files', '--follow', '--pre=happycc'])).toBe(false);
        expect(isAllowedRipgrepArgs(['--pre=happycc', 'x'])).toBe(false);
        expect(isAllowedRipgrepArgs('--files --follow')).toBe(false);
    });
});
