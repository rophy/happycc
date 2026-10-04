/**
 * Builds the `git diff` invocations the diff views run over the session shell.
 *
 * A patch only carries the lines git chose to include, so anything the viewer
 * wants beyond that — more surrounding context, whitespace-only changes folded
 * away — has to be asked of git again with different flags. Keeping the command
 * in one place means both callers ask the same way and it can be tested without
 * a shell. The commands themselves are defined in happy-wire's session command
 * list, which the CLI also uses to decide what it will run.
 */
import type { SessionCommand } from '@slopus/happy-wire';

export { quoteShellPath } from '@slopus/happy-wire';

export interface GitDiffOptions {
    /** Lines of context around each change. Omit for git's default of 3. */
    contextLines?: number;
    /** Fold away changes that are only whitespace. */
    ignoreWhitespace?: boolean;
}

/** Context wide enough to swallow any real file, used for "show everything". */
export const FULL_FILE_CONTEXT = 100_000;

export function buildGitDiffCommand(path: string, options: GitDiffOptions = {}): SessionCommand {
    return {
        kind: 'gitDiffHeadFile',
        path,
        ...(options.contextLines !== undefined ? { contextLines: options.contextLines } : {}),
        ...(options.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    };
}

/** Reads a tracked file as it stands in HEAD, base64 so binary survives. */
export function buildGitShowBase64Command(path: string): SessionCommand {
    return { kind: 'gitShowHeadBase64', path };
}
