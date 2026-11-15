import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const pluginRoot = path.join(root, 'plugins/npu-bridge');
export const hostVersion = '0.2.2-rc.3';
export const pnpmVersion = '11.28.5';
export const runtimeNames = ['adapter.mjs', 'artifact-access.mjs', 'config.mjs', 'contract.mjs', 'io.mjs', 'server.mjs', 'store.mjs', 'README.md', 'adapter-contract.md', 'config.example.json', 'task.example.json'];
export const docNames = ['plugin-installation.md', 'deployment-integration-contract.md', 'deployment-acceptance.md', 'backend-contract.md'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const json = value => `${JSON.stringify(value, null, 2)}\n`;
export const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));

export function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

export async function safePath(base, relative) {
  assert(!path.isAbsolute(relative), `Absolute source path refused: ${relative}`);
  const target = path.resolve(base, relative);
  assert(inside(base, target), `Path escapes package boundary: ${relative}`);
  let current = base;
  assert(!(await lstat(current)).isSymbolicLink(), `Symlink root refused: ${base}`);
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assert(!(await lstat(current)).isSymbolicLink(), `Symlink refused: ${relative}`);
  }
  assert(inside(await realpath(base), await realpath(target)), `Resolved source escapes root: ${relative}`);
  return target;
}

export async function fileList(base, relative = '') {
  const dir = await safePath(base, relative);
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Symlink refused: ${name}`);
    if (entry.isDirectory()) results.push(...await fileList(base, name));
    else {
      assert(entry.isFile(), `Non-regular file refused: ${name}`);
      await safePath(base, name);
      results.push(name);
    }
  }
  return results.sort();
}

export function allowedName(name) {
  if (name.includes('\\') || name.startsWith('/') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (/(^|\/)(?:\.git|\.local|\.env(?:\..*)?|node_modules|tests?|fixtures?|verification|credentials?|secrets?|sdk|weights?|models?)(\/|$)/i.test(name)) return false;
  return ['package.json', 'README.md', 'LICENSE', 'NOTICE.md', 'cordis.patch.yml', 'bin/sn4ck-npu-service.mjs', 'runtime/MANIFEST.json'].includes(name)
    || /^lib\/[A-Za-z0-9_-]+\.(?:js|d\.ts)$/.test(name)
    || runtimeNames.some(file => name === `runtime/${file}`)
    || docNames.some(file => name === `runtime/docs/${file}`);
}

export function inspectText(name, data) {
  assert(data.length <= 2 * 1024 * 1024, `Unexpectedly large release file: ${name}`);
  assert(!data.includes(0), `Binary data refused: ${name}`);
  const text = data.toString('utf8');
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text), `Private key found: ${name}`);
  assert(!/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,})/.test(text), `Credential-shaped text found: ${name}`);
  assert(!/["'](?:apiToken|apiKey|password|accessToken)["']\s*:\s*["'][^"']{16,}["']/.test(text), `Embedded credential value found: ${name}`);
}

function importsOf(name, text) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0, `Cannot parse release source: ${name}`);
  const imports = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) imports.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      assert(node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0]), `Nonliteral module load refused: ${name}`);
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(imports)];
}

export function validatePayload(files) {
  const names = [...files.keys()];
  for (const [name, data] of files) {
    assert(allowedName(name), `File not allowlisted: ${name}`);
    inspectText(name, data);
  }
  const pkg = JSON.parse(files.get('package.json'));
  assert.equal(pkg.name, 'dsh-sn4ck');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, '>=24.9.0 <25');
  assert.equal(pkg.main, './lib/index.js');
  assert.equal(pkg.types, './lib/index.d.ts');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.bin['sn4ck-npu-service'], './bin/sn4ck-npu-service.mjs');
  assert.equal(pkg.exports['.'].import, './lib/index.js');
  assert.equal(pkg.exports['.'].types, './lib/index.d.ts');
  for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']) assert.equal(pkg.peerDependencies[dependency], '*');
  assert(!pkg.scripts || Object.keys(pkg.scripts).every(key => !/^(?:preinstall|install|postinstall|prepare|prepack|postpack)$/.test(key)), 'Install/build lifecycle scripts are not allowed in the release');
  assert(!pkg.bundledDependencies && !pkg.bundleDependencies, 'Bundled node_modules refused');
  for (const file of ['lib/index.js', 'lib/index.d.ts', 'LICENSE', 'NOTICE.md', 'cordis.patch.yml', 'bin/sn4ck-npu-service.mjs', ...runtimeNames.map(name => `runtime/${name}`), ...docNames.map(name => `runtime/docs/${name}`)]) assert(files.has(file), `Missing release entry: ${file}`);
  assert.match(files.get('LICENSE').toString('utf8'), /^MIT License/m);
  assert.equal(files.get('cordis.patch.yml').toString('utf8').replaceAll('\r\n', '\n').trim(), '- insert:\n    - id: sn4ck\n      name: dsh-sn4ck');
  const example = JSON.parse(files.get('runtime/config.example.json'));
  assert.equal(example.adapter, null);
  assert.equal(example.operatorAuthorization, null);
  assert.equal(example.resourceLockPath, null);
  const declared = { ...pkg.dependencies, ...pkg.peerDependencies };
  const external = new Set();
  for (const [name, data] of files) {
    if (!/\.(?:m?js|ts)$/.test(name)) continue;
    for (const spec of importsOf(name, data.toString('utf8'))) {
      if (builtinModules.includes(spec) || spec.startsWith('node:') && builtinModules.includes(spec.slice(5))) continue;
      if (spec.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), spec));
        assert(!target.startsWith('../') && files.has(target), `Missing or escaping dependency: ${name} -> ${spec}`);
      } else {
        assert(name.startsWith('lib/'), `Runtime must use only Node builtins: ${name} -> ${spec}`);
        const packageName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        assert(Object.hasOwn(declared, packageName), `Undeclared plugin dependency: ${spec}`);
        assert(!/^(?:file:|link:|workspace:|https?:|git)/.test(declared[packageName]), `Nonregistry dependency refused: ${packageName}`);
        external.add(packageName);
      }
    }
  }
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length, 'Case-colliding archive entries');
  return { package: pkg, externalDependencies: [...external].sort(), runtimeDependencies: 'node: builtins only' };
}

export function archiveFiles(buffer) {
  const tar = gunzipSync(buffer, { maxOutputLength: 16 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  const field = (header, start, size) => header.subarray(start, start + size).toString('utf8').split('\0')[0];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert(tar.subarray(offset).every(byte => byte === 0), 'Unexpected data after tar terminator');
      return files;
    }
    const storedSum = Number.parseInt(field(header, 148, 8).trim(), 8);
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(storedSum, sum, 'Invalid tar checksum');
    const prefix = field(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
    const type = field(header, 156, 1);
    assert(type === '0' || type === '', `Nonregular tar entry refused: ${name}`);
    assert(name.startsWith('package/'), `Tar entry outside package root: ${name}`);
    const relative = name.slice(8);
    assert(allowedName(relative) && !files.has(relative), `Unexpected or duplicate tar entry: ${relative}`);
    const sizeText = field(header, 124, 12).trim();
    assert(/^[0-7]+$/.test(sizeText), 'Unsupported tar size');
    const size = Number.parseInt(sizeText, 8);
    assert(size <= 2 * 1024 * 1024 && offset + 512 + size <= tar.length, `Invalid tar entry size: ${name}`);
    files.set(relative, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Tar terminator missing');
}

export async function invalidateInstallation(dist, basename, archiveDigest, suffix = 'installation') {
  assert(['installation', 'official-cli'].includes(suffix), 'Unknown release evidence suffix');
  const relative = `${basename}.${suffix}.json`;
  const file = path.join(dist, relative);
  let previous;
  try { previous = await readFile(await safePath(dist, relative)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!previous && suffix !== 'installation') return;
  const old = previous ? JSON.parse(previous.toString('utf8')) : null;
  if (old?.sha256 === archiveDigest) return;
  let history;
  if (previous) {
    history = `${basename}.${suffix}.${sha256(previous).slice(0, 16)}.json`;
    try { await writeFile(path.join(dist, history), previous, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(sha256(await readFile(await safePath(dist, history))), sha256(previous), 'Historical installation evidence changed');
    }
  }
  await writeFile(file, json({
    schemaVersion: suffix === 'installation' ? 'calculet.package-install-test/v1' : 'calculet.official-cli-check/v1', status: 'not_run',
    sha256: archiveDigest, invalidatedAt: new Date().toISOString(),
    ...(history ? { previousEvidence: history } : {}),
    message: suffix === 'installation'
      ? 'The archive bytes changed. Run npm run test:package for this SHA-256 before claiming a clean-install pass.'
      : 'The archive bytes changed. Regenerate the supplemental official CLI evidence for this SHA-256 before claiming a pass.',
    checks: { hardware: 'not_run', planningModelConversation: 'not_run' },
  }));
}

export function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const result = candidates.find(value => value?.endsWith('npm-cli.js') && existsSync(value));
  assert(result, 'Run through npm run, or install npm alongside Node 24.');
  return result;
}

export async function command(executable, args, { cwd = root, env = process.env, timeout = 120000, log, quiet = false } = {}) {
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let exceeded = false;
  const timer = setTimeout(() => { exceeded = true; child.kill(); }, timeout);
  const collect = data => {
    output += data.toString();
    if (!quiet) process.stdout.write(data);
    if (Buffer.byteLength(output) > 8 * 1024 * 1024) { exceeded = true; child.kill(); }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally {
    clearTimeout(timer);
    if (log) await writeFile(log, output);
  }
  assert(!exceeded && code === 0, `Command failed (${exceeded ? 'timeout/output limit' : code}): ${executable} ${args.join(' ')}${log ? `; log: ${log}` : `\n${output}`}`);
  return output;
}
