const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildExpoConfig } = require('./expoConfig.cjs');

function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function loadBuildMetadata() {
    const commitSha =
        process.env.HAPPY_BUILD_COMMIT_SHA ||
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        process.env.HAPPY_BUILD_COMMIT_TIMESTAMP ||
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

/** The organization's app config file named by APP_CONFIG, relative to the working directory. */
function loadAppConfigFile() {
    const raw = process.env.APP_CONFIG && process.env.APP_CONFIG.trim();
    if (!raw) {
        return null;
    }
    const file = path.resolve(process.cwd(), raw);
    try {
        return { path: file, contents: fs.readFileSync(file, 'utf8') };
    } catch (e) {
        throw new Error(`APP_CONFIG: cannot read ${file}: ${e.message}`);
    }
}

export default buildExpoConfig(process.env, loadBuildMetadata(), {
    configFile: loadAppConfigFile(),
    projectRoot: __dirname,
});
