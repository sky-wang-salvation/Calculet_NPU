import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { startService } from '../server.mjs';
import { hashFile } from '../io.mjs';
import { sha256 } from '../contract.mjs';

export const TOKEN = 'offline-tests-only-0123456789abcdef0123456789abcdef';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const fixture = path.join(HERE, 'fixtures', 'simulation-adapter.mjs');
export const sampleSpec = () => ({
  schemaVersion: 'calculet.task/v1', intent: 'deploy-and-validate', modelId: 'sd35-medium', profileId: 'sd35-qproj-hybrid-smoke-v1',
  parameters: { prompt: 'A red apple on a wooden table', seed: 20261115, width: 256, height: 256, batch: 1, steps: 4, guidanceScale: 1, enableT5: false },
  constraints: { executionMode: 'hybrid', requireFullNpu: false, allowNpuComputeFallback: false },
  acceptance: { level: 'hybrid-smoke' },
});
const executableHash = hashFile(process.execPath);
const scriptHash = hashFile(fixture);

export async function harness(t, { mode = 'ok', config: patch = {}, clock } = {}) {
  const base = path.join(HERE, '.local');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'test-'));
  const modelRoot = path.join(root, 'model');
  await mkdir(modelRoot);
  const manifest = 'SIMULATION ONLY: this is not a model component.';
  await writeFile(path.join(modelRoot, 'manifest.json'), manifest);
  const invocations = path.join(root, 'invocations.jsonl');
  const config = {
    listen: { host: '127.0.0.1', port: 0 }, storageDir: path.join(root, 'private'),
    adapter: {
      executionKind: 'simulation', executable: process.execPath, executableSha256: await executableHash,
      script: fixture, scriptSha256: await scriptHash, cwd: root, modelRoot,
      components: [{ path: 'manifest.json', sha256: sha256(manifest) }], args: [mode],
      timeoutMs: 5000, environment: { FIXTURE_INVOCATIONS: invocations },
    }, ...patch,
  };
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });
  const context = {
    root, config, modelRoot, invocations,
    async start(overrides = {}, env = { ...process.env, CALCULET_DEPLOY_TOKEN: TOKEN }) {
      const service = await startService({ config: { ...config, ...overrides }, env, ...(clock ? { clock } : {}) });
      services.push(service);
      return service;
    },
    async calls() {
      try { return (await readFile(invocations, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
  context.service = await context.start();
  return context;
}

export async function request(service, method, route, body, extraHeaders = {}) {
  const response = await fetch(`${service.url}${route}`, {
    method, redirect: 'manual',
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
export function rawRequest(service, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${service.url}${route}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Raw test request timeout')));
    req.on('error', reject);
    req.end();
  });
}
export async function plan(service, spec = sampleSpec()) {
  const response = await request(service, 'POST', '/v1/deployment-plans', { spec });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
export async function apply(service, p, key = `test-key-${p.id}`) {
  return request(service, 'POST', '/v1/deployment-jobs', { planId: p.id, planDigest: p.planDigest, idempotencyKey: key });
}
export async function waitJob(service, id, { generation = false, timeout = 15000, until } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await request(service, 'GET', `/v1/${generation ? 'jobs' : 'deployment-jobs'}/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (until ? until(result.body) : !['queued', 'running'].includes(result.body.status)) return result.body;
    await delay(20);
  }
  assert.fail(`Timed out waiting for offline job ${id}`);
}
