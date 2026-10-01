const { execFileSync } = require('node:child_process');
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

// HAPPY_SERVER_URL is the build's server (spec §3); the app reads it as
// EXPO_PUBLIC_HAPPY_SERVER_URL, which Expo inlines when bundling.
if (process.env.HAPPY_SERVER_URL && process.env.HAPPY_SERVER_URL.trim()) {
    process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = process.env.HAPPY_SERVER_URL.trim();
}

export default buildExpoConfig(process.env, loadBuildMetadata());
