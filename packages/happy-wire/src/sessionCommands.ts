/**
 * The only shell commands and file searches the app may ask a running session to run.
 *
 * The app's git views (status badge, changes, diffs) read the workstation through the session's `bash`
 * and `ripgrep` RPCs. Those RPCs bypass the agent and its permission prompts, so the CLI accepts nothing
 * but the entries listed here: the app builds its command strings with `buildSessionCommand`, and the
 * CLI turns an incoming string back into a fixed argv with `parseSessionCommand` and runs it without a
 * shell. Adding a command means adding it here; both sides pick it up.
 */

export type SessionCommand =
    | { kind: 'gitIsRepo' }
    | { kind: 'gitStatus'; showStash: boolean }
    | { kind: 'gitDiffNumstat'; cached: boolean }
    /** Unstaged and staged numstat in one call, separated by a `---STAGED---` line. */
    | { kind: 'gitDiffNumstatBoth' }
    | { kind: 'gitLsFiles' }
    /** Working tree against the index for one file. */
    | { kind: 'gitDiffFile'; path: string }
    /** Working tree against HEAD for one file. */
    | { kind: 'gitDiffHeadFile'; path: string; contextLines?: number; ignoreWhitespace?: boolean }
    /** A file as it stands in HEAD, base64 encoded so binary survives. */
    | { kind: 'gitShowHeadBase64'; path: string }
    /** An untracked file's contents. */
    | { kind: 'readFile'; path: string };

/** How the CLI runs a command: each step without a shell, stopping at the first failure. */
export interface SessionCommandPlan {
    /** argv per step; argv[0] is the program. */
    steps: string[][];
    /** Printed between the steps' outputs. */
    separator?: string;
    /** `base64` encodes the combined output. */
    output: 'text' | 'base64';
    /** File paths the command touches, relative to its cwd; each must stay inside the session folder. */
    paths: string[];
}

export const STAGED_SEPARATOR = '---STAGED---';

const GIT = ['git', '-c', 'core.quotepath=false'];
const STATUS = [...GIT, 'status', '--porcelain=v2', '--branch'];
const NUMSTAT = [...GIT, 'diff', '--numstat'];
const CACHED_NUMSTAT = [...GIT, 'diff', '--cached', '--numstat'];

/** Quotes a path for a double-quoted shell argument (the form the app has always sent). */
export function quoteShellPath(path: string): string {
    return `"${path.replace(/([\\"$`])/g, '\\$1')}"`;
}

const QUOTED = '"((?:[^"\\\\$`]|\\\\[\\\\"$`])*)"';
const unquote = (s: string) => s.replace(/\\([\\"$`])/g, '$1');

function headDiffFlags(cmd: { contextLines?: number; ignoreWhitespace?: boolean }): string[] {
    const flags = ['--no-ext-diff'];
    if (cmd.contextLines !== undefined) flags.push(`-U${cmd.contextLines}`);
    if (cmd.ignoreWhitespace) flags.push('-w');
    return flags;
}

export function buildSessionCommand(cmd: SessionCommand): string {
    switch (cmd.kind) {
        case 'gitIsRepo':
            return 'git rev-parse --is-inside-work-tree';
        case 'gitStatus':
            return [...STATUS, ...(cmd.showStash ? ['--show-stash'] : []), '--untracked-files=all'].join(' ');
        case 'gitDiffNumstat':
            return (cmd.cached ? CACHED_NUMSTAT : NUMSTAT).join(' ');
        case 'gitDiffNumstatBoth':
            return `${NUMSTAT.join(' ')} && echo "${STAGED_SEPARATOR}" && ${CACHED_NUMSTAT.join(' ')}`;
        case 'gitLsFiles':
            return [...GIT, 'ls-files', '--cached', '--others', '--exclude-standard'].join(' ');
        case 'gitDiffFile':
            return `git diff --no-ext-diff -- ${quoteShellPath(cmd.path)}`;
        case 'gitDiffHeadFile':
            return `${[...GIT, 'diff', 'HEAD', ...headDiffFlags(cmd)].join(' ')} -- ${quoteShellPath(cmd.path)}`;
        case 'gitShowHeadBase64':
            return `${GIT.join(' ')} show HEAD:${quoteShellPath(cmd.path)} | base64`;
        case 'readFile':
            return `cat -- ${quoteShellPath(cmd.path)}`;
    }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (cmd: SessionCommand) => new RegExp(`^${escape(buildSessionCommand(cmd))}$`);
const withPath = (prefix: string, suffix = '') => new RegExp(`^${escape(prefix)}${QUOTED}${escape(suffix)}$`);

const FIXED: SessionCommand[] = [
    { kind: 'gitIsRepo' },
    { kind: 'gitStatus', showStash: true },
    { kind: 'gitStatus', showStash: false },
    { kind: 'gitDiffNumstat', cached: false },
    { kind: 'gitDiffNumstat', cached: true },
    { kind: 'gitDiffNumstatBoth' },
    { kind: 'gitLsFiles' },
];

const HEAD_DIFF = new RegExp(
    `^${escape([...GIT, 'diff', 'HEAD', '--no-ext-diff'].join(' '))}(?: -U(0|[1-9]\\d{0,5}))?( -w)? -- ${QUOTED}$`,
);

/** The listed command a string was built from, or `null` if it is not on the list. */
export function parseSessionCommand(command: string): SessionCommand | null {
    for (const cmd of FIXED) {
        if (exact(cmd).test(command)) return cmd;
    }
    let m = withPath('git diff --no-ext-diff -- ').exec(command);
    if (m) return { kind: 'gitDiffFile', path: unquote(m[1]) };
    m = HEAD_DIFF.exec(command);
    if (m) {
        const cmd: SessionCommand = { kind: 'gitDiffHeadFile', path: unquote(m[3]) };
        if (m[1] !== undefined) cmd.contextLines = Number(m[1]);
        if (m[2]) cmd.ignoreWhitespace = true;
        return cmd;
    }
    m = withPath(`${GIT.join(' ')} show HEAD:`, ' | base64').exec(command);
    if (m) return { kind: 'gitShowHeadBase64', path: unquote(m[1]) };
    m = withPath('cat -- ').exec(command);
    if (m) return { kind: 'readFile', path: unquote(m[1]) };
    return null;
}

export function sessionCommandPlan(cmd: SessionCommand): SessionCommandPlan {
    switch (cmd.kind) {
        case 'gitIsRepo':
            return { steps: [['git', 'rev-parse', '--is-inside-work-tree']], output: 'text', paths: [] };
        case 'gitStatus':
            return {
                steps: [[...STATUS, ...(cmd.showStash ? ['--show-stash'] : []), '--untracked-files=all']],
                output: 'text',
                paths: [],
            };
        case 'gitDiffNumstat':
            return { steps: [cmd.cached ? CACHED_NUMSTAT : NUMSTAT], output: 'text', paths: [] };
        case 'gitDiffNumstatBoth':
            return { steps: [NUMSTAT, CACHED_NUMSTAT], separator: `${STAGED_SEPARATOR}\n`, output: 'text', paths: [] };
        case 'gitLsFiles':
            return {
                steps: [[...GIT, 'ls-files', '--cached', '--others', '--exclude-standard']],
                output: 'text',
                paths: [],
            };
        case 'gitDiffFile':
            return { steps: [['git', 'diff', '--no-ext-diff', '--', cmd.path]], output: 'text', paths: [cmd.path] };
        case 'gitDiffHeadFile':
            return {
                steps: [[...GIT, 'diff', 'HEAD', ...headDiffFlags(cmd), '--', cmd.path]],
                output: 'text',
                paths: [cmd.path],
            };
        case 'gitShowHeadBase64':
            return { steps: [[...GIT, 'show', `HEAD:${cmd.path}`]], output: 'base64', paths: [cmd.path] };
        case 'readFile':
            return { steps: [['cat', '--', cmd.path]], output: 'text', paths: [cmd.path] };
    }
}

/** The only argument lists the app may pass to the session's `ripgrep` RPC. */
export const SESSION_RIPGREP_SEARCHES = {
    /** Every file in the session folder, for `@file` suggestions. */
    listFiles: ['--files', '--follow'],
} as const satisfies Record<string, readonly string[]>;

export type SessionRipgrepSearch = keyof typeof SESSION_RIPGREP_SEARCHES;

export function isAllowedRipgrepArgs(args: unknown): boolean {
    return Array.isArray(args) && Object.values(SESSION_RIPGREP_SEARCHES).some(
        (allowed) => allowed.length === args.length && allowed.every((a, i) => a === args[i]),
    );
}
