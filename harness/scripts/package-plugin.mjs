import assert from 'node:assert/strict';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  root, pluginRoot, hostVersion, runtimeNames, docNames, sha256, json,
  safePath, fileList, validatePayload, archiveFiles, invalidateInstallation, npmCli, command,
} from './package-support.mjs';

async function main() {
  assert.equal(process.argv.length, 2, 'Usage: npm run package:plugin');
  const inputs = new Map();
  async function readInput(name) {
    const data = await readFile(await safePath(root, name));
    inputs.set(name, sha256(data));
    return data;
  }
  const pkg = JSON.parse(await readInput('plugins/npu-bridge/package.json'));
  const lock = JSON.parse(await readInput('package-lock.json'));
  assert.equal(lock.packages['plugins/npu-bridge'].version, pkg.version, 'Sync the workspace lockfile first');
  assert.equal(pkg.engines.node, '>=24.9.0 <25');
  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await safePath(root, 'dist');
  const work = await mkdtemp(path.join(dist, '.pack-'));
  const stage = path.join(work, 'package');
  await mkdir(stage);
  const origins = new Map();
  async function copy(source, destination, transform) {
    const input = await readInput(source);
    const output = transform ? Buffer.from(transform(input.toString('utf8'))) : input;
    await mkdir(path.dirname(path.join(stage, destination)), { recursive: true });
    await writeFile(path.join(stage, destination), output, { flag: 'wx' });
    origins.set(destination, { source, sourceSha256: sha256(input) });
  }
  const sourceNames = await fileList(pluginRoot, 'src');
  assert(sourceNames.length && sourceNames.every(name => /^src\/[A-Za-z0-9_-]+\.ts$/.test(name)), 'Unexpected plugin source layout; review the allowlist');
  for (const name of sourceNames) await readInput(`plugins/npu-bridge/${name}`);
  await readInput('plugins/npu-bridge/tsconfig.json');
  await command(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(pluginRoot, 'tsconfig.json'), '--outDir', path.join(stage, 'lib'), '--sourceMap', 'false'], { log: path.join(work, 'build.log') });
  for (const name of await fileList(stage, 'lib')) origins.set(name, { source: 'plugins/npu-bridge/src (TypeScript 5.9.3 compilation)' });
  const release = { ...pkg };
  delete release.devDependencies;
  delete release.scripts;
  await writeFile(path.join(stage, 'package.json'), json(release), { flag: 'wx' });
  origins.set('package.json', { source: 'plugins/npu-bridge/package.json (development scripts/dependencies omitted)' });
  await copy('plugins/npu-bridge/cordis.patch.yml', 'cordis.patch.yml');
  await copy('plugins/npu-bridge/LICENSE', 'LICENSE');
  await copy('plugins/npu-bridge/NOTICE.md', 'NOTICE.md');
  await copy('plugins/npu-bridge/bin/sn4ck-npu-service.mjs', 'bin/sn4ck-npu-service.mjs');
  await chmod(path.join(stage, 'bin/sn4ck-npu-service.mjs'), 0o755);
  await copy('plugins/npu-bridge/README.md', 'README.md', text => '> 发行归档说明：插件与部署服务已预编译并完整收录。直接安装与运行请先读 [安装指南](runtime/docs/plugin-installation.md)；下文源码开发测试命令只适用于完整源码检出。\n\n' + text
    .replaceAll('../../docs/local-development.md', 'runtime/docs/plugin-installation.md')
    .replaceAll('../../docs/windows-integration.md', 'runtime/docs/plugin-installation.md')
    .replaceAll('../../docs/', 'runtime/docs/')
    + '\n## 安装发行归档\n\n本归档包含预编译插件和完整 Node 部署服务，不需要本仓库工作区。安装与默认阻塞自检见 [安装指南](runtime/docs/plugin-installation.md)。源码开发检查命令仅适用于源码检出；发布包不包含测试或演示适配器。\n');
  for (const name of runtimeNames) await copy(`deployment/${name}`, `runtime/${name}`, name === 'README.md'
    ? text => '> 发行归档说明：本文件保留服务源码目录下的说明与测试命令。归档不包含 test/ 或 fixture；独立安装与 CLI 操作以 [插件安装指南](docs/plugin-installation.md) 为准。\n\n' + text.replaceAll('../docs/', './docs/') : undefined);
  for (const name of docNames) await copy(`docs/${name}`, `runtime/docs/${name}`, name === 'plugin-installation.md'
    ? text => text.replaceAll('../deployment/', '../') : undefined);
  const payload = new Map();
  for (const name of await fileList(stage)) payload.set(name, await readFile(path.join(stage, name)));
  const validation = validatePayload(payload);
  const payloadManifest = {
    schemaVersion: 'calculet.release-files/v1', name: pkg.name, version: pkg.version,
    hostVersion, runtimeDependencies: validation.runtimeDependencies,
    peerDependencies: pkg.peerDependencies,
    inputs: [...inputs].map(([source, digest]) => ({ source, sha256: digest })),
    files: [...payload].map(([name, data]) => ({ path: name, bytes: data.length, sha256: sha256(data), ...origins.get(name) })),
    excludes: ['source tests and fixtures', '.local', 'node_modules', 'credentials', 'SDK', 'model weights', 'real model adapters'],
    limitations: ['No model or hardware execution verified by packaging', 'No authorized planning-model conversation verified', 'Default adapter=null keeps deployment blocked'],
  };
  const manifestData = Buffer.from(json(payloadManifest));
  await writeFile(path.join(stage, 'runtime/MANIFEST.json'), manifestData, { flag: 'wx' });
  payload.set('runtime/MANIFEST.json', manifestData);
  const npmOutput = await command(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: stage, quiet: true, log: path.join(work, 'npm-pack.json') });
  const packed = JSON.parse(npmOutput);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, `${pkg.name}-${pkg.version}.tgz`);
  const archivePath = path.join(work, packed[0].filename);
  const archive = await readFile(archivePath);
  const archived = archiveFiles(archive);
  validatePayload(archived);
  assert.deepEqual([...archived.keys()].sort(), [...payload.keys()].sort(), 'npm pack added or omitted files');
  for (const [name, data] of archived) assert.equal(sha256(data), sha256(payload.get(name)), `Archive changed ${name}`);
  for (const [source, digest] of inputs) assert.equal(sha256(await readFile(await safePath(root, source))), digest, `Release source changed during packaging: ${source}; rerun after integration stabilizes.`);
  const runtimeDir = path.join(pluginRoot, 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  await safePath(pluginRoot, 'runtime');
  for (const name of await fileList(runtimeDir)) {
    assert(payload.has(`runtime/${name}`), `Unknown existing generated runtime file: ${name}`);
    await readFile(await safePath(runtimeDir, name));
  }
  for (const [name, data] of payload) {
    if (!name.startsWith('runtime/')) continue;
    const target = path.join(runtimeDir, name.slice(8));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  const finalArchive = path.join(dist, packed[0].filename);
  try {
    assert((await lstat(finalArchive)).isFile(), 'Release destination is not a regular file');
    validatePayload(archiveFiles(await readFile(finalArchive)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archiveDigest = sha256(archive);
  await invalidateInstallation(dist, `${pkg.name}-${pkg.version}`, archiveDigest);
  await invalidateInstallation(dist, `${pkg.name}-${pkg.version}`, archiveDigest, 'official-cli');
  await copyFile(archivePath, finalArchive);
  const manifest = {
    ...payloadManifest, generatedAt: new Date().toISOString(),
    archive: { file: packed[0].filename, bytes: archive.length, sha256: archiveDigest, npmIntegrity: packed[0].integrity },
    files: [...archived].map(([name, data]) => ({ path: name, bytes: data.length, sha256: sha256(data), ...origins.get(name) })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
    validation: { allowlist: 'passed', regularFilesOnly: 'passed', importClosure: 'passed', contentScan: 'passed', cleanInstallation: 'Run npm run test:package separately; packaging does not imply installation or hardware success.' },
  };
  for (const [name, content] of [
    [`${pkg.name}-${pkg.version}.manifest.json`, json(manifest)],
    [`${pkg.name}-${pkg.version}.sha256`, `${archiveDigest}  ${packed[0].filename}\n`],
  ]) {
    const target = path.join(dist, name);
    try { await readFile(await safePath(dist, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(target, content);
  }
  process.stdout.write(json({ archive: finalArchive, sha256: archiveDigest, files: archived.size, bytes: archive.length, buildEvidence: work, hardware: 'not_run' }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
