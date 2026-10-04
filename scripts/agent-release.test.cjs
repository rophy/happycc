const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseInput, checkManifest, checkVersionOutput, checkPackage } = require('./agent-release.cjs');

test('agent releases get their own tag and tarball', () => {
  assert.deepEqual(releaseInput('0.1.0', 'latest'), {
    version: '0.1.0', channel: 'latest', tag: 'agent-0.1.0', tarball: 'happycc-agent-0.1.0.tgz',
  });
  assert.throws(() => releaseInput('0.1.0', 'beta'));
});

const manifest = () => ({
  name: '@happycc/agent', version: '0.1.0',
  repository: { url: 'https://github.com/rophy/happycc' },
  dependencies: { commander: '^13.1.0' },
  devDependencies: { '@slopus/happy-wire': 'workspace:*' },
  bin: { 'happycc-agent': './bin/happy-agent.mjs' },
});

test('rejects the wrong package, a runtime wire dependency, and another repository', () => {
  assert.throws(() => checkManifest({ ...manifest(), repository: { url: 'https://github.com/other/happy' } }, '0.1.0'));
  checkManifest({ ...manifest(), repository: { url: 'git+https://github.com/rophy/happycc.git' } }, '0.1.0');
  assert.throws(() => checkManifest({ ...manifest(), name: '@happycc/cli' }, '0.1.0'));
  assert.throws(() => checkManifest({ ...manifest(), dependencies: { '@slopus/happy-wire': '0.1.0' } }, '0.1.0'), /happy-wire/);
});

test('checks the exact version output', () => {
  checkVersionOutput('0.1.0\n', '0.1.0');
  assert.throws(() => checkVersionOutput('0.1.01\n', '0.1.0'));
});

test('packaging gate requires the entrypoint and rejects runtime wire imports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['bin', 'dist']) fs.mkdirSync(path.join(root, directory));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest()));
  for (const file of ['dist/index.mjs', 'dist/index.cjs']) fs.writeFileSync(path.join(root, file), '');
  assert.throws(() => checkPackage(root, '0.1.0'), /Missing happycc-agent entrypoint/);
  fs.writeFileSync(path.join(root, 'bin/happy-agent.mjs'), '');
  checkPackage(root, '0.1.0');
  fs.writeFileSync(path.join(root, 'dist/index.mjs'), 'import { x } from "@slopus/happy-wire";');
  assert.throws(() => checkPackage(root, '0.1.0'), /Runtime happy-wire import/);
});
