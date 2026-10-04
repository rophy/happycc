/**
 * Session-scoped file/shell RPCs: the app's own listed commands run (against a real git repo); anything
 * else, writes, and difftastic are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSessionCommand, SESSION_RIPGREP_SEARCHES } from '@slopus/happy-wire';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from './registerCommonHandlers';

type Handler = (data: unknown) => Promise<any>;

function registerFor(workingDirectory: string): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const manager = { registerHandler: (method: string, handler: Handler) => handlers.set(method, handler) };
    registerCommonHandlers(manager as unknown as RpcHandlerManager, workingDirectory);
    return handlers;
}

describe('session-scoped RPC handlers', () => {
    let root: string;
    let repo: string;
    let handlers: Map<string, Handler>;
    const bash = (command: string, cwd?: string) => handlers.get('bash')!({ command, cwd: cwd ?? repo, timeout: 10_000 });

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'happycc-session-rpc-'));
        repo = join(root, 'repo');
        execFileSync('git', ['init', '-q', repo]);
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 255]));
        git('add', '-A');
        git('commit', '-qm', 'init');
        writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
        writeFileSync(join(repo, 'staged.txt'), 'new\n');
        git('add', 'staged.txt');
        writeFileSync(join(repo, 'untracked.txt'), 'hello\n');
        handlers = registerFor(repo);
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('runs the listed git commands', async () => {
        expect(await bash(buildSessionCommand({ kind: 'gitIsRepo' }))).toMatchObject({ success: true, stdout: 'true\n' });
        const status = await bash(buildSessionCommand({ kind: 'gitStatus', showStash: true }));
        expect(status.success).toBe(true);
        expect(status.stdout).toContain('a.txt');
        const diff = await bash(buildSessionCommand({ kind: 'gitDiffHeadFile', path: 'a.txt' }));
        expect(diff.stdout).toContain('+two');
    });

    it('joins the combined numstat like the shell did', async () => {
        const res = await bash(buildSessionCommand({ kind: 'gitDiffNumstatBoth' }));
        expect(res).toMatchObject({ success: true, stdout: '1\t0\ta.txt\n---STAGED---\n1\t0\tstaged.txt\n' });
    });

    it('base64-encodes a HEAD read and reads untracked files', async () => {
        const head = await bash(buildSessionCommand({ kind: 'gitShowHeadBase64', path: 'logo.bin' }));
        expect(Buffer.from(head.stdout, 'base64')).toEqual(Buffer.from([0, 1, 2, 255]));
        const file = await bash(buildSessionCommand({ kind: 'readFile', path: 'untracked.txt' }));
        expect(file).toMatchObject({ success: true, stdout: 'hello\n' });
    });

    it('refuses commands that are not listed, without running them', async () => {
        const marker = join(root, 'pwned');
        for (const command of [`touch ${marker}`, `git rev-parse --is-inside-work-tree && touch ${marker}`, 'happycc']) {
            expect(await bash(command)).toMatchObject({ success: false, error: 'Command not allowed' });
        }
        // A crafted file name stays a literal argument: git sees no such file, nothing runs.
        const sneaky = await bash(buildSessionCommand({ kind: 'gitDiffFile', path: `$(touch ${marker})` }));
        expect(sneaky.stdout).toBe('');
        expect(existsSync(marker)).toBe(false);
    });

    it('refuses a cwd or file outside the session folder', async () => {
        expect((await bash(buildSessionCommand({ kind: 'gitIsRepo' }), '/')).success).toBe(false);
        expect((await bash(buildSessionCommand({ kind: 'gitIsRepo' }), root)).success).toBe(false);
        expect((await bash(buildSessionCommand({ kind: 'readFile', path: '../../etc/passwd' }))).success).toBe(false);
        expect((await bash(buildSessionCommand({ kind: 'readFile', path: '/etc/passwd' }))).success).toBe(false);
    });

    it('refuses writes and difftastic', async () => {
        const target = join(repo, 'written.txt');
        const write = await handlers.get('writeFile')!({ path: target, content: Buffer.from('x').toString('base64'), expectedHash: null });
        expect(write.success).toBe(false);
        expect(existsSync(target)).toBe(false);
        expect((await handlers.get('difftastic')!({ args: ['a', 'b'], cwd: repo })).success).toBe(false);
    });

    it('accepts only the listed ripgrep searches', async () => {
        expect(await handlers.get('ripgrep')!({ args: ['--pre=touch', 'x'], cwd: repo })).toEqual({ success: false, error: 'Search not allowed' });
        const listed = await handlers.get('ripgrep')!({ args: [...SESSION_RIPGREP_SEARCHES.listFiles], cwd: repo });
        expect(listed.error).not.toBe('Search not allowed');
    });
});
