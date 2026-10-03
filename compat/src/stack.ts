/** Thin wrappers over `docker compose` used by every scenario. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export type Service = 'cli' | 'app';
export type ExecResult = { stdout: string; stderr: string; code: number };

function run(args: string[], timeoutMs: number): Promise<ExecResult> {
    return new Promise((done) => {
        execFile('docker', ['compose', ...args], { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout, stderr) => done({ stdout, stderr, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0 }));
    });
}

export async function exec(service: Service, cmd: string, opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<ExecResult> {
    const result = await run(['exec', '-T', service, 'sh', '-lc', cmd], opts.timeoutMs ?? 120_000);
    if (result.code !== 0 && !opts.allowFail) {
        throw new Error(`[${service}] ${cmd}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
    }
    return result;
}

export async function execDetached(service: Service, cmd: string): Promise<void> {
    const result = await run(['exec', '-d', service, 'sh', '-lc', cmd], 30_000);
    if (result.code !== 0) throw new Error(`[${service}] detached ${cmd} failed: ${result.stderr}`);
}

export async function compose(args: string): Promise<void> {
    const result = await run(args.split(' '), 300_000);
    if (result.code !== 0) throw new Error(`docker compose ${args} failed: ${result.stderr}`);
}

export async function agentJson<T>(args: string): Promise<T> {
    const { stdout } = await exec('app', `happycc-agent ${args} --json`);
    return JSON.parse(stdout) as T;
}

export async function poll<T>(fn: () => Promise<T | undefined>, opts: { timeoutMs: number; intervalMs?: number; what: string }): Promise<T> {
    const deadline = Date.now() + opts.timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value !== undefined) return value;
        } catch (error) {
            lastError = error;
        }
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
    }
    throw new Error(`Timed out waiting for ${opts.what}${lastError ? `: ${String(lastError)}` : ''}`);
}

/** Single-quote a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function extractUrl(text: string, pattern: RegExp): string | undefined {
    const clean = text.replace(ANSI, '');
    return clean.match(/https?:\/\/[^\s<>"'\x00-\x1f]+/g)?.map((url) => url.replace(/[.,;:!?)\]}]+$/, '')).find((url) => pattern.test(url));
}
