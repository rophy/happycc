/**
 * Focused regression test for the `auth login` command's option wiring in
 * `index.ts`. Everything else about the CLI surface is covered either by
 * `cli-smoke.test.ts`/`index.test.ts` (which run the built binary as a
 * subprocess, so they cannot mock `./auth`) or by `auth.test.ts` (which
 * covers `authLogin`'s own behavior once called). This file imports
 * `index.ts` in-process with a mocked `./auth`, so it can assert that
 * Commander's `--no-browser` flag actually reaches `authLogin` as
 * `{ openBrowser: false }`, and that omitting it leaves the default alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authLogin = vi.fn(async (_config: unknown, _opts?: { openBrowser?: boolean }) => {});
vi.mock('./auth', () => ({
    authLogin,
    authLogout: vi.fn(async () => {}),
    authStatus: vi.fn(async () => {}),
}));

let originalArgv: string[];
let originalHomeDir: string | undefined;

beforeEach(() => {
    vi.resetModules();
    authLogin.mockClear();
    originalArgv = process.argv;
    originalHomeDir = process.env.HAPPY_HOME_DIR;
    process.env.HAPPY_HOME_DIR = '/tmp/happy-agent-cli-wiring-test';
});

afterEach(() => {
    process.argv = originalArgv;
    if (originalHomeDir === undefined) {
        delete process.env.HAPPY_HOME_DIR;
    } else {
        process.env.HAPPY_HOME_DIR = originalHomeDir;
    }
});

async function runCliInProcess(...args: string[]): Promise<void> {
    process.argv = ['node', 'happy-agent', ...args];
    await import('./index');
    // index.ts's program.parseAsync(...) is not top-level awaited, so give
    // its action callback a turn to run before asserting on the mock.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

describe('auth login CLI wiring', () => {
    it('passes openBrowser: false through to authLogin for --no-browser', async () => {
        await runCliInProcess('auth', 'login', '--no-browser');
        expect(authLogin).toHaveBeenCalledTimes(1);
        expect(authLogin.mock.calls[0][1]).toEqual({ openBrowser: false });
    });

    it('passes openBrowser: true by default (no --no-browser flag)', async () => {
        await runCliInProcess('auth', 'login');
        expect(authLogin).toHaveBeenCalledTimes(1);
        expect(authLogin.mock.calls[0][1]).toEqual({ openBrowser: true });
    });
});
