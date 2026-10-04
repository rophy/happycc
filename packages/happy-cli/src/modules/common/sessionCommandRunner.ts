import { execFile } from 'child_process';
import { parseSessionCommand, sessionCommandPlan } from '@slopus/happy-wire';
import { validatePath } from './pathSecurity';

export interface SessionCommandResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs a session-scoped `bash` request. Only the commands listed in happy-wire's sessionCommands are
 * accepted; each runs as a fixed argv without a shell, inside the session folder.
 */
export async function runSessionCommand(
    request: { command: string; cwd?: string; timeout?: number },
    workingDirectory: string,
): Promise<SessionCommandResult> {
    const cmd = typeof request.command === 'string' ? parseSessionCommand(request.command) : null;
    if (!cmd) {
        return { success: false, exitCode: 1, error: 'Command not allowed' };
    }
    const cwd = validatePath(request.cwd ?? workingDirectory, workingDirectory);
    if (!cwd.valid) {
        return { success: false, exitCode: 1, error: cwd.error };
    }
    const plan = sessionCommandPlan(cmd);
    for (const path of plan.paths) {
        const target = validatePath(path, cwd.resolvedPath!);
        if (!target.valid || !validatePath(target.resolvedPath!, workingDirectory).valid) {
            return { success: false, exitCode: 1, error: `Access denied: Path '${path}' is outside the working directory` };
        }
    }
    const timeout = Math.min(Math.max(Number(request.timeout) || MAX_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);

    const outputs: Buffer[] = [];
    const stderrs: string[] = [];
    for (const [i, [program, ...args]] of plan.steps.entries()) {
        const step = await runStep(program, args, cwd.resolvedPath!, timeout);
        stderrs.push(step.stderr);
        if (i > 0 && plan.separator) outputs.push(Buffer.from(plan.separator));
        outputs.push(step.stdout);
        if (step.error) {
            return {
                success: false,
                stdout: Buffer.concat(outputs).toString('utf8'),
                stderr: stderrs.join(''),
                exitCode: step.exitCode,
                error: step.error,
            };
        }
    }
    const stdout = Buffer.concat(outputs);
    return {
        success: true,
        stdout: plan.output === 'base64' ? stdout.toString('base64') : stdout.toString('utf8'),
        stderr: stderrs.join(''),
        exitCode: 0,
    };
}

function runStep(program: string, args: string[], cwd: string, timeout: number) {
    return new Promise<{ stdout: Buffer; stderr: string; exitCode: number; error?: string }>((resolve) => {
        execFile(
            program,
            args,
            { cwd, timeout, encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
            (error, stdout, stderr) => {
                const out = { stdout: stdout ?? Buffer.alloc(0), stderr: stderr ? stderr.toString('utf8') : '' };
                if (!error) {
                    resolve({ ...out, exitCode: 0 });
                    return;
                }
                const timedOut = (error as { killed?: boolean }).killed === true;
                resolve({
                    ...out,
                    exitCode: typeof error.code === 'number' ? error.code : timedOut ? -1 : 1,
                    error: timedOut ? 'Command timed out' : error.message,
                });
            },
        );
    });
}
