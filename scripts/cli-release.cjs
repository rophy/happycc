const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PACKAGE_NAME = '@happycc/cli';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

/**
 * The npm channel of a release version: X.Y.Z goes to `latest`, X.Y.Z-beta.N to `beta`.
 * Shared with agent-release.cjs.
 */
function releaseChannel(version) {
  assert(typeof version === 'string' && VERSION.test(version), `Version must be X.Y.Z or X.Y.Z-beta.N, got ${version}`);
  return version.includes('-beta.') ? 'beta' : 'latest';
}

/** Orders X.Y.Z and X.Y.Z-beta.N versions; a beta ranks below its stable version. */
function compareVersions(a, b) {
  const parse = (version) => {
    const [, major, minor, patch, beta] = VERSION.exec(version) ?? assert.fail(`Not a release version: ${version}`);
    return [Number(major), Number(minor), Number(patch), beta === undefined ? Infinity : Number(beta)];
  };
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** A release must be newer than the version npm serves as `latest` (none before the first release). */
function checkNewer(version, latest) {
  if (!latest) return;
  assert(compareVersions(version, latest) > 0, `${version} is not newer than the latest release ${latest}`);
}

function releaseInput(version) {
  const channel = releaseChannel(version);
  return { version, channel, tag: `cli/${version}`, tarball: `happycc-cli-${version}.tgz` };
}

function checkManifest(manifest, version) {
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.equal(manifest.version, version);
  const repository = typeof manifest.repository === 'string'
    ? manifest.repository : manifest.repository?.url;
  assert.equal(repository?.replace(/^git\+/, '').replace(/\.git$/, ''),
    'https://github.com/rophy/happycc', 'Provenance must identify rophy/happycc');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert(!manifest[field]?.['@slopus/happy-wire'], 'happy-wire must be bundled, not a runtime dependency');
    for (const spec of Object.values(manifest[field] || {})) {
      assert(!/^(workspace|file|link):/.test(spec), `Unresolved runtime dependency: ${spec}`);
    }
  }
}

function checkVersionOutput(output, version) {
  assert(output.split(/\r?\n/).includes(`happycc version: ${version}`),
    `The installed CLI did not report happycc version: ${version}\n${output}`);
}

function checkPackage(root, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  checkManifest(manifest, version);
  // The bin *keys* are the published command names; the entrypoint filenames
  // stay on their original names (bin/happy.mjs) to limit upstream-merge churn.
  for (const [bin, file] of [['happycc', 'happy'], ['happy-mcp', 'happy-mcp']]) {
    assert.equal(manifest.bin?.[bin]?.replace(/^\.\//, ''), `bin/${file}.mjs`);
    assert(fs.existsSync(path.join(root, manifest.bin[bin])), `Missing ${bin} entrypoint`);
  }
  for (const file of ['dist/index.mjs', 'dist/index.cjs', 'dist/lib.mjs', 'dist/lib.cjs']) {
    assert(fs.existsSync(path.join(root, file)), `Missing ${file}`);
  }
  const wireImport = /(?:\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)['"]@slopus\/happy-wire(?:\/[^'"]*)?['"]/;
  for (const file of fs.readdirSync(path.join(root, 'dist'), { recursive: true })) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    assert(!wireImport.test(fs.readFileSync(path.join(root, 'dist', file), 'utf8')),
      `Runtime happy-wire import in ${file}`);
  }
  for (const tool of ['ripgrep', 'difftastic']) {
    for (const platform of ['arm64-darwin', 'x64-darwin', 'arm64-linux', 'x64-linux', 'arm64-win32', 'x64-win32']) {
      assert(fs.existsSync(path.join(root, 'tools', 'archives', `${tool}-${platform}.tar.gz`)),
        `Missing ${tool} archive for ${platform}`);
    }
  }
  for (const directory of ['tools/server', 'tools/webapp']) {
    assert(!fs.existsSync(path.join(root, directory)), `${directory} belongs in happy-server-self-host`);
  }
}

function smoke(prefix, version) {
  const root = path.join(prefix, 'node_modules', ...PACKAGE_NAME.split('/'));
  checkPackage(root, version);
  for (const args of [['--version'], ['--help'], ['doctor']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/happy.mjs'), ...args], {
      cwd: prefix,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HAPPY_HOME_DIR: path.join(prefix, 'happycc-home'),
        HAPPY_BOOT_AGENT: '0',
        HAPPY_EXPERIMENTAL: '0',
      },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `happycc ${args.join(' ')} failed`);
    if (args[0] === '--version') checkVersionOutput(result.stdout, version);
  }
}

async function main() {
  const release = releaseInput(process.env.RELEASE_VERSION);
  const [command, target] = process.argv.slice(2);
  if (command === 'validate') {
    checkNewer(release.version, process.env.RELEASE_LATEST);
    console.log(`Validated ${PACKAGE_NAME}@${release.version} for ${release.channel}`);
  } else if (command === 'check-package') {
    checkPackage(target, release.version);
  } else if (command === 'smoke') {
    smoke(target, release.version);
  } else {
    throw new Error(`Unknown release command: ${command}`);
  }
}

module.exports = { releaseChannel, compareVersions, checkNewer, releaseInput, checkManifest, checkVersionOutput, checkPackage };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });