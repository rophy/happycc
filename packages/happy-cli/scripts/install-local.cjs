#!/usr/bin/env node

/**
 * Install this workspace as the global `happycc` binary for local development.
 *
 * Steps:
 *   1. build
 *   2. stop a daemon left by a previous install (ignores failure; this build has no daemon)
 *   3. npm link (replaces the globally-installed `happycc` with a symlink to this workspace)
 *   4. verify by running `happycc --version`
 *
 * Reuses ~/.happycc/ — no separate dev home dir. Auth and sessions carry over.
 * To undo: `npm unlink -g happycc && npm i -g happycc@latest`.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

function run(cmd, args, { allowFailure = false, env = process.env } = {}) {
    const label = [cmd, ...args].join(' ');
    console.log(`\n▶ ${label}`);
    const result = spawnSync(cmd, args, {
        cwd: PACKAGE_DIR,
        stdio: 'inherit',
        env,
        // shell: true resolves `.cmd` shims on Windows so `pnpm` / `npm` / `happycc` are found.
        shell: IS_WINDOWS,
    });
    if (result.error) {
        console.error(`Failed to spawn: ${label}`, result.error.message);
        if (!allowFailure) process.exit(1);
        return 1;
    }
    const status = result.status ?? 1;
    if (status !== 0 && !allowFailure) {
        console.error(`\nExit ${status}: ${label}`);
        process.exit(status);
    }
    return status;
}

run('pnpm', ['run', 'build']);
// Clean up a daemon left over from a previous (daemon-enabled) install.
run('happycc', ['daemon', 'stop'], { allowFailure: true });
run('npm', ['link']);
run('happycc', ['--version']);

console.log(`\n✓ Installed from ${PACKAGE_DIR}`);
console.log('  To undo: npm unlink -g happycc && npm i -g happycc@latest');
