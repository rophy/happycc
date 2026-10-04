export type ResumeCommandMetadata = {
    path?: string | null;
    os?: string | null;
    flavor?: string | null;
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
    client?: { id?: string | null } | null;
    capabilities?: { resume?: boolean | null } | null;
};

export type ResumeCommandBlock = {
    lines: string[];
    copyText: string;
};

function quotePosixPath(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellPath(path: string): string {
    return `'${path.replace(/'/g, `''`)}'`;
}

function isWindows(metadata: ResumeCommandMetadata): boolean {
    return metadata.os?.toLowerCase() === 'win32';
}

/**
 * `happycc resume <session id>` reattaches this same session (history kept) rather than starting a new
 * one on the agent's conversation; it needs the agent's own resume id, so it is offered only when that exists.
 */
function buildResumeInvocation(metadata: ResumeCommandMetadata, sessionId: string): string | null {
    if (metadata.client?.id === 'rig' || metadata.capabilities?.resume === false) {
        return null;
    }
    const isCodex = metadata.flavor === 'codex' || metadata.flavor === 'openai' || metadata.flavor === 'gpt';
    if ((isCodex && metadata.codexThreadId) || metadata.claudeSessionId) {
        return `happycc resume ${sessionId}`;
    }
    return null;
}

function buildChangeDirectoryCommand(metadata: ResumeCommandMetadata): string | null {
    const path = metadata.path?.trim();
    if (!path) {
        return null;
    }

    return isWindows(metadata)
        ? `Set-Location -LiteralPath ${quotePowerShellPath(path)}`
        : `cd ${quotePosixPath(path)}`;
}

export function buildResumeCommandBlock(metadata: ResumeCommandMetadata, sessionId: string): ResumeCommandBlock | null {
    const invocation = buildResumeInvocation(metadata, sessionId);
    if (!invocation) {
        return null;
    }

    const changeDirectoryCommand = buildChangeDirectoryCommand(metadata);
    const lines = changeDirectoryCommand
        ? [changeDirectoryCommand, invocation]
        : [invocation];

    return {
        lines,
        copyText: lines.join('\n'),
    };
}

export function buildResumeCommand(metadata: ResumeCommandMetadata, sessionId: string): string | null {
    const commandBlock = buildResumeCommandBlock(metadata, sessionId);
    if (!commandBlock) {
        return null;
    }
    return commandBlock.lines.join(isWindows(metadata) ? '; ' : ' && ');
}
