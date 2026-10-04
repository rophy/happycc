const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkReleaseVersion, checkManifest: checkCliManifest } = require('./cli-release.cjs');

const PACKAGE_NAME = '@happycc/agent';

function releaseInput(version, channel) {
  checkReleaseVersion(version, channel);
  return { version, channel, tag: `agent-${version}`, tarball: `happycc-agent-${version}.tgz` };
}

function checkManifest(manifest, version) {
  assert.equal(manifest.name, PACKAGE_NAME);
  // The CLI's checks cover the version, provenance repository and runtime dependencies.
  checkCliManifest({ ...manifest, name: '@happycc/cli' }, version);
}

function checkVersionOutput(output, version) {
  assert.equal(output.trim(), version, `The installed agent did not report ${version}\n${output}`);
}

function checkPackage(root, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  checkManifest(manifest, version);
  assert.equal(manifest.bin?.['happycc-agent']?.replace(/^\.\//, ''), 'bin/happy-agent.mjs');
  assert(fs.existsSync(path.join(root, manifest.bin['happycc-agent'])), 'Missing happycc-agent entrypoint');
  for (const file of ['dist/index.mjs', 'dist/index.cjs']) {
    assert(fs.existsSync(path.join(root, file)), `Missing ${file}`);
  }
  const wireImport = /(?:\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)['"]@slopus\/happy-wire(?:\/[^'"]*)?['"]/;
  for (const file of fs.readdirSync(path.join(root, 'dist'), { recursive: true })) {
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    assert(!wireImport.test(fs.readFileSync(path.join(root, 'dist', file), 'utf8')),
      `Runtime happy-wire import in ${file}`);
  }
}

function smoke(prefix, version) {
  const root = path.join(prefix, 'node_modules', ...PACKAGE_NAME.split('/'));
  checkPackage(root, version);
  for (const args of [['--version'], ['--help']]) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/happy-agent.mjs'), ...args], {
      cwd: prefix,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HAPPY_HOME_DIR: path.join(prefix, 'happycc-home') },
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `happycc-agent ${args.join(' ')} failed`);
    if (args[0] === '--version') checkVersionOutput(result.stdout, version);
  }
}

async function main() {
  const release = releaseInput(process.env.RELEASE_VERSION, process.env.RELEASE_CHANNEL);
  const [command, target] = process.argv.slice(2);
  if (command === 'validate') {
    console.log(`Validated ${PACKAGE_NAME}@${release.version} for ${release.channel}`);
  } else if (command === 'prepare') {
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
    manifest.version = release.version;
    checkManifest(manifest, release.version);
    fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (command === 'check-package') {
    checkPackage(target, release.version);
  } else if (command === 'smoke') {
    smoke(target, release.version);
  } else {
    throw new Error(`Unknown release command: ${command}`);
  }
}

module.exports = { releaseInput, checkManifest, checkVersionOutput, checkPackage };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
