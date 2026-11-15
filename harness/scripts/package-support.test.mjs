import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  root, runtimeNames, docNames, allowedName, safePath, fileList, validatePayload, invalidateInstallation, readJSON,
} from './package-support.mjs';

function payload() {
  const files = new Map();
  const pkg = {
    name: 'dsh-sn4ck', version: '0.2.0', engines: { node: '>=24.9.0 <25' },
    main: './lib/index.js', types: './lib/index.d.ts', license: 'MIT',
    exports: { '.': { import: './lib/index.js', types: './lib/index.d.ts' } },
    bin: { 'sn4ck-npu-service': './bin/sn4ck-npu-service.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/cordis': '*', '@deepseek-ai/dsh-tools': '*', '@deepseek-ai/dsh-llm': '*', '@deepseek-ai/schemastery': '*' },
  };
  for (const file of ['README.md', 'LICENSE', 'NOTICE.md', 'cordis.patch.yml', 'lib/index.js', 'lib/index.d.ts', 'bin/sn4ck-npu-service.mjs', ...runtimeNames.map(name => `runtime/${name}`), ...docNames.map(name => `runtime/docs/${name}`)]) files.set(file, Buffer.from(''));
  files.set('package.json', Buffer.from(JSON.stringify(pkg)));
  files.set('LICENSE', Buffer.from('MIT License\n\nCopyright (c) 2026 DSH-SN4CK contributors\n'));
  files.set('NOTICE.md', Buffer.from('Only original plugin code is MIT; third-party materials retain their own licenses.\n'));
  files.set('cordis.patch.yml', Buffer.from('- insert:\n    - id: sn4ck\n      name: dsh-sn4ck\n'));
  files.set('runtime/config.example.json', Buffer.from(JSON.stringify({ adapter: null, operatorAuthorization: null, resourceLockPath: null })));
  return files;
}

test('release allowlist rejects sensitive folders, traversal, and unknown files', () => {
  for (const name of ['.env', '.local/state.json', 'runtime/test/fixture.mjs', 'runtime/node_modules/x.js', 'runtime/weights/model.bin', 'runtime/sdk/private.mjs', '../package.json', 'lib/../../secret.js', 'lib\\index.js', '/package.json', 'runtime/unreviewed.mjs', 'lib/index.js.map']) assert.equal(allowedName(name), false, name);
  for (const name of ['package.json', 'LICENSE', 'NOTICE.md', 'lib/index.js', 'lib/index.d.ts', 'runtime/server.mjs', 'runtime/docs/plugin-installation.md']) assert.equal(allowedName(name), true, name);
});

test('dependency closure rejects missing, escaping, undeclared, and dynamic loads', () => {
  assert.doesNotThrow(() => validatePayload(payload()));
  for (const source of ["import './missing.js';", "import '../../outside.js';", "import 'not-declared';", "await import(process.env.MODULE);"]) {
    const files = payload();
    files.set('lib/index.js', Buffer.from(source));
    assert.throws(() => validatePayload(files), /dependency|Nonliteral/);
  }
  const files = payload();
  files.set('runtime/server.mjs', Buffer.from("import '@deepseek-ai/cordis';"));
  assert.throws(() => validatePayload(files), /only Node builtins/);
});

test('release rejects private keys, credential values, binary data, and executable defaults', () => {
  for (const text of ['-----BEGIN PRIVATE KEY-----', JSON.stringify({ apiToken: 'x'.repeat(40) }), '\0binary']) {
    const files = payload();
    files.set('README.md', Buffer.from(text));
    assert.throws(() => validatePayload(files), /Private key|credential|Binary/);
  }
  const files = payload();
  files.set('runtime/config.example.json', Buffer.from(JSON.stringify({ adapter: {}, operatorAuthorization: null, resourceLockPath: null })));
  assert.throws(() => validatePayload(files));
});

test('changed archive invalidates current installation evidence and preserves history', async t => {
  await mkdir(path.join(root, '.local'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.local/package-evidence-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const basename = 'dsh-sn4ck-0.2.0';
  const previous = { schemaVersion: 'calculet.package-install-test/v1', status: 'passed', sha256: 'a'.repeat(64) };
  await writeFile(path.join(base, `${basename}.installation.json`), JSON.stringify(previous));
  await invalidateInstallation(base, basename, 'b'.repeat(64));
  const current = await readJSON(path.join(base, `${basename}.installation.json`));
  assert.equal(current.status, 'not_run');
  assert.equal(current.sha256, 'b'.repeat(64));
  assert.deepEqual(await readJSON(path.join(base, current.previousEvidence)), previous);
  await invalidateInstallation(base, basename, 'b'.repeat(64));
  assert.deepEqual(await readJSON(path.join(base, `${basename}.installation.json`)), current);
  await writeFile(path.join(base, `${basename}.official-cli.json`), JSON.stringify(previous));
  await invalidateInstallation(base, basename, 'b'.repeat(64), 'official-cli');
  const supplemental = await readJSON(path.join(base, `${basename}.official-cli.json`));
  assert.equal(supplemental.status, 'not_run');
  assert.equal(supplemental.sha256, 'b'.repeat(64));
  assert.deepEqual(await readJSON(path.join(base, supplemental.previousEvidence)), previous);
});

test('copy boundary rejects traversal and symlinks without dereferencing', async t => {
  await mkdir(path.join(root, '.local'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.local/package-guard-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(path.join(base, 'file.txt'), 'safe');
  assert.equal(await safePath(base, 'file.txt'), path.join(base, 'file.txt'));
  await assert.rejects(safePath(base, '../package.json'), /escapes/);
  try { await symlink(path.join(base, 'file.txt'), path.join(base, 'link.txt')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Windows symlink privilege unavailable; traversal check passed.'); return; } throw error; }
  await assert.rejects(safePath(base, 'link.txt'), /Symlink/);
  await assert.rejects(fileList(base), /Symlink/);
});
