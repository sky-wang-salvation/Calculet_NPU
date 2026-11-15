import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  root, hostVersion, pnpmVersion, inside, safePath, readJSON, json, sha256,
  archiveFiles, validatePayload, npmCli, command,
} from './package-support.mjs';

let sandbox;
let report;
async function main() {
  assert.equal(process.argv.length, 2, 'Usage: npm run test:package');
  const pkg = await readJSON(path.join(root, 'plugins/npu-bridge/package.json'));
  const basename = `${pkg.name}-${pkg.version}`;
  const archive = await safePath(root, `dist/${basename}.tgz`);
  const archiveData = await readFile(archive);
  const release = await readJSON(await safePath(root, `dist/${basename}.manifest.json`));
  assert.equal(sha256(archiveData), release.archive.sha256, 'Archive SHA-256 does not match release manifest');
  const files = archiveFiles(archiveData);
  validatePayload(files);
  assert.equal(files.size, release.files.length);
  for (const entry of release.files) assert.equal(sha256(files.get(entry.path)), entry.sha256, `Manifest mismatch: ${entry.path}`);
  const embedded = JSON.parse(files.get('runtime/MANIFEST.json'));
  for (const entry of embedded.files) assert.equal(sha256(files.get(entry.path)), entry.sha256, `Embedded manifest mismatch: ${entry.path}`);
  await mkdir(path.join(root, '.local'), { recursive: true });
  await safePath(root, '.local');
  sandbox = await mkdtemp(path.join(root, '.local/package-install-'));
  const app = path.join(sandbox, 'app');
  const tools = path.join(sandbox, 'tools');
  const home = path.join(sandbox, 'home');
  const dshHome = path.join(sandbox, 'dsh-home');
  const logs = path.join(sandbox, 'logs');
  for (const directory of [app, tools, home, dshHome, logs, path.join(sandbox, 'tmp')]) await mkdir(directory, { recursive: true });
  for (const file of ['npmrc', 'global.npmrc']) await writeFile(path.join(sandbox, file), '');
  const cache = path.join(root, '.local/npm-cache');
  const env = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) if (/^(?:path|systemroot|windir|comspec|pathext|http_proxy|https_proxy|no_proxy|lang|lc_all|node_extra_ca_certs)$/i.test(key) && typeof value === 'string') env[key] = value;
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    DSH_HOME: dshHome, TEMP: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp'),
    NPM_CONFIG_USERCONFIG: path.join(sandbox, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(sandbox, 'global.npmrc'),
    NPM_CONFIG_CACHE: cache, NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_MAXSOCKETS: '1',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_FETCH_RETRIES: '2',
    CI: 'true', NO_COLOR: '1', DSH_TELEMETRY: '0',
  });
  report = {
    schemaVersion: 'calculet.package-install-test/v1', startedAt: new Date().toISOString(),
    archive: path.relative(root, archive).replaceAll('\\', '/'), sha256: release.archive.sha256,
    packageVersion: pkg.version, hostVersion, pnpmVersion, node: process.version, npm: 'not_checked',
    platform: `${process.platform}/${process.arch}`, sandbox, status: 'running', commands: [],
    checks: { archiveAllowlistAndHashes: 'passed', hardware: 'not_run', planningModelConversation: 'not_run', simulationAdapter: 'not_included_or_used' },
  };
  async function run(label, executable, args, options = {}) {
    report.commands.push({ label, executable, args, cwd: options.cwd ?? app });
    console.log(`\n[package-test] ${label}`);
    const result = await command(executable, args, { cwd: app, env, timeout: 600000, log: path.join(logs, `${label}.log`), ...options });
    await writeFile(path.join(sandbox, 'progress.json'), json(report));
    return result;
  }
  report.npm = (await run('npm-version', process.execPath, [npmCli(), '--version'], { quiet: true })).trim();
  await writeFile(path.join(app, 'package.json'), json({ name: 'calculet-clean-install-check', version: '0.0.0', private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': hostVersion, [pkg.name]: `file:${archive.replaceAll('\\', '/')}` } }));
  await run('clean-npm-install', process.execPath, [npmCli(), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--maxsockets=1', '--fetch-retries=2', '--workspaces=false']);
  report.checks.cleanNpmInstall = 'passed: fresh app, ignore-scripts, no global profile';
  const installedPkg = await readJSON(await safePath(app, `node_modules/${pkg.name}/package.json`));
  assert.equal(installedPkg.version, pkg.version);
  for (const name of files.keys()) assert.equal(sha256(await readFile(await safePath(app, `node_modules/${pkg.name}/${name}`))), sha256(files.get(name)), `Installation changed payload: ${name}`);
  report.checks.installedPayloadHashes = 'passed';
  await run('dependency-tree', process.execPath, [npmCli(), 'ls', '--omit=dev', '--all', '--json'], { quiet: true });
  report.checks.dependencyTree = 'passed: npm ls --omit=dev --all';
  const guard = path.join(app, 'resolution-guard.mjs');
  await copyFile(await safePath(root, 'scripts/package-isolation.mjs'), guard);
  const isolatedEnv = { ...env, CALCULET_PACKAGE_TEST_ROOT: sandbox, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
  const negativeProbe = path.join(app, 'guard-negative.mjs');
  await writeFile(negativeProbe, `import assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\nimport { writeFile } from 'node:fs/promises';\nconst denied = error => error.code === 'PACKAGE_TEST_RESOLUTION_ESCAPE';\nawait assert.rejects(import('typescript'), denied);\nassert.throws(() => createRequire(import.meta.url)('typescript'), denied);\nawait writeFile(new URL('./guard-transitive.mjs', import.meta.url), "import 'typescript';\\n");\nawait assert.rejects(import('./guard-transitive.mjs'), denied);\nconsole.log('ESM, CommonJS and transitive ancestor fallback are denied.');\n`);
  await run('module-resolution-negative-check', process.execPath, [negativeProbe], { env: isolatedEnv });
  report.checks.moduleResolutionBoundary = 'passed: Node registerHooks denies all file modules outside sandbox; ESM/CommonJS/transitive negative checks passed';
  const probe = path.join(app, 'probe.mjs');
  await copyFile(await safePath(root, 'scripts/package-probe.mjs'), probe);
  await run('installed-plugin-and-runtime', process.execPath, [probe, app, path.join(logs, 'probe-result.json')], { env: isolatedEnv });
  report.checks.probe = await readJSON(path.join(logs, 'probe-result.json'));
  const installedCli = path.join(app, 'node_modules', pkg.name, 'bin/sn4ck-npu-service.mjs');
  assert.match(await run('installed-cli-version', process.execPath, [installedCli, '--version'], { env: isolatedEnv }), new RegExp(`${pkg.name} ${pkg.version.replaceAll('.', '\\.')}`));
  assert.match(await run('installed-cli-help', process.execPath, [installedCli, '--help'], { env: isolatedEnv }), /Usage: sn4ck-npu-service/);
  await writeFile(path.join(tools, 'package.json'), json({ name: 'calculet-local-package-manager', version: '0.0.0', private: true, dependencies: { pnpm: pnpmVersion } }));
  await run('local-pnpm-install', process.execPath, [npmCli(), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--maxsockets=1', '--fetch-retries=2', '--workspaces=false'], { cwd: tools });
  const pnpm = path.join(tools, 'node_modules/pnpm/bin/pnpm.cjs');
  assert.equal((await run('local-pnpm-version', process.execPath, [pnpm, '--version'], { env: isolatedEnv })).trim(), pnpmVersion);
  const officialCli = path.join(app, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  await run('official-cli-help', process.execPath, [officialCli, 'plugin', '--help'], { env: isolatedEnv });
  const carrier = path.join(app, 'dsh-local.mjs');
  await writeFile(carrier, `import { runCli } from ${JSON.stringify(pathToFileURL(officialCli).href)};\nawait runCli({ packageManager: { command: process.execPath, args: [${JSON.stringify(pnpm)}] } });\n`);
  const profile = 'calculet-package-check';
  await run('official-profile-initialize', process.execPath, [officialCli, '--profile', profile, '--from-default-profile', 'web', '--dump-config'], { quiet: true, env: isolatedEnv });
  await run('official-plugin-add', process.execPath, [carrier, 'plugin', '--profile', profile, 'add', archive, '--ignore-scripts', '--network-concurrency=1', '--child-concurrency=1', '--store-dir', path.join(sandbox, 'pnpm-store'), '--reporter=append-only'], { env: isolatedEnv });
  const profileDir = path.join(dshHome, 'profiles', profile);
  assert(inside(sandbox, profileDir));
  const profileManifest = await readJSON(path.join(profileDir, 'package.json'));
  assert(profileManifest.dsh.profile.bundles.includes(pkg.name), 'Official CLI did not activate the plugin bundle');
  assert(profileManifest.dependencies[pkg.name], 'Official CLI did not install the tgz');
  const dump = await run('official-dump-config', process.execPath, [officialCli, '--profile', profile, '--dump-config'], { env: isolatedEnv });
  assert.match(dump, /id: sn4ck/);
  assert.match(dump, /dsh-sn4ck/);
  assert(!/skipped|incompatible|unreadable/i.test(dump), 'Official dump skipped a bundle');
  report.checks.officialPluginAdd = 'passed: unmodified official runCli with installation-owned local pnpm, local tgz, fresh DSH_HOME';
  report.checks.officialBundleActivation = 'passed: dsh.profile.bundles includes dsh-sn4ck';
  report.checks.officialDumpConfig = 'passed: calculet-npu entry present';
  report.checks.globalEnvironment = 'unchanged: isolated HOME, DSH_HOME, npmrc and local pnpm';
  assert.equal(sha256(await readFile(archive)), release.archive.sha256, 'Archive changed while installation tests were running; rebuild and rerun.');
  assert.equal((await readJSON(path.join(root, 'dist', `${basename}.manifest.json`))).archive.sha256, release.archive.sha256, 'Release manifest changed during installation testing.');
  report.finishedAt = new Date().toISOString();
  report.status = 'passed';
  const output = path.join(root, 'dist', `${basename}.installation.json`);
  try { await readFile(await safePath(root, `dist/${basename}.installation.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(output, json(report));
  await writeFile(path.join(sandbox, 'report.json'), json(report));
  console.log(json({ status: report.status, archive, sha256: report.sha256, report: output, evidence: sandbox, hardware: 'not_run', planningModel: 'not_run' }));
}

main().catch(async error => {
  if (sandbox && report) {
    report.status = 'failed';
    report.error = error.message;
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(sandbox, 'report.json'), json(report)).catch(() => {});
    console.error(`Package test failed; evidence: ${sandbox}`);
  }
  console.error(error.message);
  process.exitCode = 1;
});
