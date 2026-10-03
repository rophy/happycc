/**
 * Vitest global setup: waits for the compose stack, signs both devices in as
 * `alice` through the OIDC mock, and records pinned tool versions.
 *
 * Set COMPAT_UNIT_ONLY=1 to skip everything here (pure unit tests, no stack).
 *
 * "Already signed in" detection: both CLIs exit 0 from `auth status` whether or
 * not they are signed in, so the signal is the output. Unauthenticated prints
 * "Not authenticated" (happycc: "✗ Not authenticated"; happycc-agent:
 * "- Status: Not authenticated"). We treat "signed in" as: output present and
 * NOT matching /not authenticated/i.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, exec, execDetached, extractUrl, poll, type Service } from './stack';

const USER = 'alice';

async function signedIn(service: Service, cmd: string): Promise<boolean> {
    const { stdout, stderr } = await exec(service, cmd, { allowFail: true, timeoutMs: 30_000 });
    const text = `${stdout}\n${stderr}`;
    return /authenticated|signed in/i.test(text) && !/not authenticated|not signed in/i.test(text);
}

async function signIn(service: Service, loginCmd: string, urlPattern: RegExp, statusCmd: string) {
    if (await signedIn(service, statusCmd)) return;
    await exec(service, 'rm -f /tmp/compat-login.log', { allowFail: true });
    await execDetached(service, `${loginCmd} > /tmp/compat-login.log 2>&1`);
    const url = await poll(async () => {
        const { stdout } = await exec(service, 'cat /tmp/compat-login.log', { allowFail: true });
        return extractUrl(stdout, urlPattern);
    }, { timeoutMs: 60_000, what: `${service} sign-in URL` });
    await exec(service, `node /tmp/signin.mjs "${url}" ${USER}`, { timeoutMs: 60_000 });
    await poll(async () => ((await signedIn(service, statusCmd)) ? true : undefined), { timeoutMs: 60_000, what: `${service} to report signed in` });
}

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const semver = (text: string) => text.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? firstLine(text);

export default async function setup() {
    if (process.env.COMPAT_UNIT_ONLY === '1') return;

    await poll(async () => ((await exec('cli', 'curl -sf http://localhost:3005/health', { allowFail: true, timeoutMs: 15_000 })).code === 0 ? true : undefined),
        { timeoutMs: 120_000, what: 'server health' });
    // aimock answers 200 on /health.
    await poll(async () => ((await exec('cli', 'curl -sf -o /dev/null http://aimock:4010/health', { allowFail: true, timeoutMs: 15_000 })).code === 0 ? true : undefined),
        { timeoutMs: 120_000, what: 'aimock health' });

    for (const service of ['cli', 'app'] as const) {
        const { execFile } = await import('node:child_process');
        await new Promise<void>((done, fail) =>
            execFile('docker', ['compose', 'cp', resolve(REPO_ROOT, 'compat/scripts/signin.mjs'), `${service}:/tmp/signin.mjs`], { cwd: REPO_ROOT },
                (e) => (e ? fail(e) : done())));
    }

    await signIn('cli', 'happycc auth login', /\/activate\?code=/, 'happycc auth status');
    await exec('cli', 'happycc daemon start', { allowFail: true });
    await signIn('app', 'happycc-agent auth login --no-browser', /\/v1\/auth\/oidc\/login\?/, 'happycc-agent auth status');

    // Versions are read after sign-in: an unauthenticated `happycc --version` falls into the login flow.
    const v = async (service: Service, cmd: string) => semver((await exec(service, cmd, { allowFail: true, timeoutMs: 60_000 })).stdout);
    const piAcp = (await exec('cli', 'npm ls -g pi-acp --depth=0', { allowFail: true })).stdout.match(/pi-acp@(\S+)/)?.[1] ?? 'unknown';
    const versions = {
        happycc: await v('cli', 'happycc --version'),
        happyccAgent: await v('app', 'happycc-agent --version'),
        claude: await v('cli', 'claude --version'),
        opencode: await v('cli', 'opencode --version'),
        pi: await v('cli', 'pi --version 2>&1'),
        piAcp,
    };
    writeFileSync(resolve(import.meta.dirname, '..', '.versions.json'), JSON.stringify(versions, null, 2) + '\n');
}
