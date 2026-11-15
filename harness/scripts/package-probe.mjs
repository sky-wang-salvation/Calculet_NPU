import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.resolve(process.argv[2]);
const reportFile = path.resolve(process.argv[3]);
const resolvePackage = name => {
  const target = fileURLToPath(import.meta.resolve(name, undefined));
  const rel = path.relative(path.join(base, 'node_modules'), target);
  assert(!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`), `Dependency leaked outside clean installation: ${name}`);
  return target;
};
const pluginEntry = resolvePackage('dsh-sn4ck');
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-system-prompt']) resolvePackage(name);
const bridge = await import('dsh-sn4ck');
assert.equal(bridge.name, 'sn4ck');
const { Context } = await import('@deepseek-ai/cordis');
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { default: Tools } = await import('@deepseek-ai/dsh-tools');
const pluginDir = path.dirname(path.dirname(pluginEntry));
const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
const cli = path.join(pluginDir, pkg.bin['sn4ck-npu-service']);
const token = randomBytes(32).toString('hex');
const configFile = path.join(base, 'service-config.json');
const storageDir = await mkdtemp(path.join(base, 'private-deployment-state-'));
await writeFile(configFile, JSON.stringify({ listen: { host: '127.0.0.1', port: 0 }, storageDir, adapter: null }), { mode: 0o600 });
const child = spawn(process.execPath, [cli, '--config', configFile], { cwd: base, shell: false, env: { ...process.env, CALCULET_DEPLOY_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stderr = '';
let stdout = '';
child.stderr.on('data', data => { stderr += data.toString(); });
const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
let ctx;
const result = { package: `${pkg.name}@${pkg.version}`, exports: Object.keys(bridge).sort(), dependencyIsolation: 'passed', executionKind: 'not_run', hardware: 'not_run', planningModel: 'not_run' };
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service readiness timed out: ${stderr}`)), 15000);
    child.stdout.on('data', data => {
      stdout += data.toString();
      if (!stdout.includes('\n')) return;
      try { const entry = JSON.parse(stdout.split('\n')[0]); assert.equal(entry.service, 'calculet-deployment'); clearTimeout(timer); resolve(entry.url); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
    closed.then(status => { clearTimeout(timer); reject(new Error(`Service exited before ready (${status.code}): ${stderr}`)); }, reject);
  });
  const unauthenticated = await fetch(`${url}/v1/capabilities`);
  assert.equal(unauthenticated.status, 401);
  const capabilitiesResponse = await fetch(`${url}/v1/capabilities`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.executionKind, 'not_run');
  assert.deepEqual(capabilities.models, []);
  ctx = new Context();
  await ctx.plugin(SystemPrompt).await();
  await ctx.plugin(Tools).await();
  const fork = ctx.plugin(bridge, { backendURL: url, apiToken: token });
  await fork.await();
  const tools = ctx.tools.schemas().map(row => row.name).sort();
  assert.deepEqual(tools, ['npu_status', 'npu_list_models', 'npu_generate', 'npu_get_job', 'npu_wait_job', 'npu_plan_deployment', 'npu_apply_deployment', 'npu_get_deployment_job', 'npu_wait_deployment_job'].sort());
  const exec = { signal: new AbortController().signal };
  const status = await ctx.tools.get('npu_status').execute({}, exec);
  assert.equal(status.state, 'connected');
  assert.equal(status.executionKind, 'not_run');
  assert.deepEqual((await ctx.tools.get('npu_list_models').execute({}, exec)).models, []);
  const plan = await ctx.tools.get('npu_plan_deployment').execute({ prompt: 'Packaging safety check; no model execution.' }, exec);
  assert.equal(plan.status, 'blocked');
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  assert(plan.blockers.some(entry => entry.code === 'ADAPTER_NOT_CONFIGURED'));
  const blockedJob = await ctx.tools.get('npu_apply_deployment').execute({ planId: plan.id, planDigest: plan.planDigest, idempotencyKey: 'package-safety-check' }, exec);
  assert.equal(blockedJob.status, 'blocked');
  assert.equal(blockedJob.executionKind, 'not_run');
  assert.equal(blockedJob.error.code, 'ADAPTER_NOT_CONFIGURED');
  await fork.dispose();
  assert.equal(ctx.tools.schemas().length, 0);
  Object.assign(result, { nativeTools: tools, cli: 'started from installed tgz', authenticatedService: 'passed', unauthenticatedRequest: 'rejected', defaultPlan: 'blocked: ADAPTER_NOT_CONFIGURED', blockedApply: 'blocked job returned; executionKind=not_run', unload: 'passed' });
} finally {
  if (ctx) await ctx.fiber.dispose();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Service shutdown timed out')); }, 10000); })]); }
  finally { clearTimeout(timer); }
}
await writeFile(reportFile, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
