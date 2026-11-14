import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { normalizeConfig, inputPolicyBlocker } from '../config.mjs';
import { makeAdapterRequest, runAdapter } from '../adapter.mjs';
import { harness, fixture, sampleSpec, plan, apply, request, waitJob } from './helpers.mjs';

const PROFILE = 'sd35-qproj-hybrid-smoke-v1';
const policy = () => ({ prompt: sampleSpec().parameters.prompt, seed: sampleSpec().parameters.seed });
const adapterShape = () => ({
  executionKind: 'simulation', executable: process.execPath, executableSha256: 'a'.repeat(64),
  script: fixture, scriptSha256: 'b'.repeat(64), cwd: path.dirname(fixture), modelRoot: path.dirname(fixture),
  components: [{ path: 'component.json', sha256: 'c'.repeat(64) }], timeoutMs: 5000,
});
async function restricted(t) {
  const h = await harness(t);
  await h.service.close();
  h.service = await h.start({ adapter: { ...h.config.adapter, inputPolicy: policy() } });
  return h;
}
async function state(h) {
  return JSON.parse(await readFile(path.join(h.config.storageDir, 'state.json'), 'utf8'));
}

test('inputPolicy is optional, exact, normalized and strictly typed', () => {
  const without = normalizeConfig({ adapter: adapterShape() });
  assert.equal(Object.hasOwn(without.adapter, 'inputPolicy'), false);
  assert.equal(inputPolicyBlocker(without, sampleSpec()), null);
  const raw = { prompt: `  ${policy().prompt}  `, seed: 0 };
  const configured = normalizeConfig({ adapter: { ...adapterShape(), inputPolicy: raw } });
  assert.deepEqual(configured.adapter.inputPolicy, { prompt: policy().prompt, seed: 0 });
  assert.ok(raw.prompt.startsWith('  '));
  assert.doesNotThrow(() => normalizeConfig(configured));
  assert.deepEqual(normalizeConfig({ adapter: { ...adapterShape(), inputPolicy: { ...policy(), seed: 0xffffffff } } }).adapter.inputPolicy.seed, 0xffffffff);
  const invalid = [null, [], 'fixed', true, {}, { prompt: 'x' }, { seed: 1 },
    { prompt: '', seed: 1 }, { prompt: '   ', seed: 1 }, { prompt: 'x'.repeat(8001), seed: 1 },
    { prompt: 'x\0y', seed: 1 }, { prompt: 1, seed: 1 }, { prompt: 'x', seed: '1' },
    { prompt: 'x', seed: -1 }, { prompt: 'x', seed: 1.5 }, { prompt: 'x', seed: 2 ** 32 },
    { prompt: 'x', seed: 1, shell: true }];
  for (const inputPolicy of invalid) assert.throws(() => normalizeConfig({ adapter: { ...adapterShape(), inputPolicy } }));
});

test('fixed-input plans match exactly or block without launching the adapter', async t => {
  const h = await restricted(t);
  const accepted = await plan(h.service);
  assert.equal(accepted.status, 'ready');
  assert.equal(accepted.spec.parameters.width, 256);
  const mismatches = [
    { ...sampleSpec().parameters, prompt: 'A different prompt' },
    { ...sampleSpec().parameters, seed: sampleSpec().parameters.seed + 1 },
  ];
  for (const parameters of mismatches) {
    const p = await plan(h.service, { ...sampleSpec(), parameters });
    assert.equal(p.status, 'blocked');
    assert.equal(p.blockers.find(blocker => blocker.code === 'ADAPTER_INPUT_NOT_SUPPORTED')?.code, 'ADAPTER_INPUT_NOT_SUPPORTED');
    const job = await apply(h.service, p);
    assert.equal(job.body.status, 'blocked');
    assert.equal(job.body.error.code, 'ADAPTER_INPUT_NOT_SUPPORTED');
    assert.equal(job.body.executionKind, 'not_run');
  }
  assert.deepEqual(await h.calls(), []);
});

test('fixed-input generation rejects unsupported inputs before persisting jobs or starting processes', async t => {
  const h = await restricted(t);
  const unsupportedBody = { modelId: PROFILE, task: 'text-to-image', prompt: 'Not the configured prompt', seed: policy().seed };
  const beforeReady = await request(h.service, 'POST', '/v1/jobs', unsupportedBody);
  assert.equal(beforeReady.status, 409);
  assert.equal(beforeReady.body.error.code, 'ADAPTER_INPUT_NOT_SUPPORTED');
  assert.equal((await state(h)).jobs.length, 0);
  assert.deepEqual(await h.calls(), []);
  const p = await plan(h.service);
  const submitted = await apply(h.service, p);
  assert.equal((await waitJob(h.service, submitted.body.id)).status, 'succeeded');
  const capabilities = (await request(h.service, 'GET', '/v1/capabilities')).body;
  assert.equal(capabilities.executionKind, 'simulation');
  assert.match(capabilities.models[0].displayName, /fixed prompt/);
  assert.match(capabilities.models[0].displayName, /seed=20261115/);
  assert.match(capabilities.note, /exact configured prompt/);
  const before = await state(h);
  for (const body of [unsupportedBody, { ...unsupportedBody, prompt: policy().prompt, seed: policy().seed + 1 }]) {
    const rejected = await request(h.service, 'POST', '/v1/jobs', body, { 'idempotency-key': 'rejected-input-is-not-bound' });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, 'ADAPTER_INPUT_NOT_SUPPORTED');
    assert.deepEqual((await state(h)).jobs, before.jobs);
    assert.deepEqual((await state(h)).idempotency, before.idempotency);
  }
  assert.equal((await h.calls()).filter(event => event.event === 'start').length, 1);
  const accepted = await request(h.service, 'POST', '/v1/jobs', {
    modelId: PROFILE, task: 'text-to-image', prompt: `  ${policy().prompt}  `,
  }, { 'idempotency-key': 'rejected-input-is-not-bound' });
  assert.equal(accepted.status, 202);
  const result = await waitJob(h.service, accepted.body.id, { generation: true });
  assert.equal(result.status, 'succeeded');
  assert.equal((await h.calls()).filter(event => event.event === 'start').length, 2);
  const saved = JSON.parse(await readFile(path.join(h.config.storageDir, 'jobs', result.id, 'request.json'), 'utf8'));
  assert.equal(saved.spec.parameters.prompt, policy().prompt);
  assert.equal(saved.spec.parameters.seed, policy().seed);
});

test('adding, changing and removing inputPolicy changes the binding and blocks old ready plans', async t => {
  const h = await harness(t);
  const initial = await plan(h.service);
  assert.equal(initial.status, 'ready');
  await h.service.close();
  const fixed = await h.start({ adapter: { ...h.config.adapter, inputPolicy: policy() } });
  const fixedPlan = await plan(fixed);
  assert.equal(fixedPlan.status, 'ready');
  assert.notEqual(fixedPlan.planDigest, initial.planDigest);
  assert.deepEqual((await state(h)).plans.find(row => row.plan.id === fixedPlan.id).binding.inputPolicy, policy());
  const old = await apply(fixed, initial, 'policy-added');
  assert.equal(old.body.status, 'blocked');
  assert.equal(old.body.error.code, 'PLAN_BINDING_CHANGED');
  await fixed.close();
  const changed = await h.start({ adapter: { ...h.config.adapter, inputPolicy: { ...policy(), seed: 7 } } });
  const changedPlan = await plan(changed);
  assert.equal(changedPlan.status, 'blocked');
  assert.notEqual(changedPlan.planDigest, fixedPlan.planDigest);
  const stale = await apply(changed, fixedPlan, 'policy-changed');
  assert.equal(stale.body.status, 'blocked');
  assert.equal(stale.body.error.code, 'PLAN_BINDING_CHANGED');
  await changed.close();
  const generic = await h.start();
  const removedPlan = await plan(generic);
  assert.equal(removedPlan.status, 'ready');
  assert.notEqual(removedPlan.planDigest, fixedPlan.planDigest);
  assert.equal(removedPlan.planDigest, initial.planDigest);
  const staleFixed = await apply(generic, fixedPlan, 'policy-removed');
  assert.equal(staleFixed.body.status, 'blocked');
  assert.equal(staleFixed.body.error.code, 'PLAN_BINDING_CHANGED');
  assert.deepEqual(await h.calls(), []);
});

test('the immediate adapter launch guard independently rejects unsupported input', async t => {
  const h = await harness(t);
  const cfg = normalizeConfig({ ...h.config, adapter: { ...h.config.adapter, inputPolicy: policy() } });
  const directory = path.join(h.root, 'unsupported-input-job');
  await mkdir(directory); await mkdir(path.join(directory, 'artifacts'));
  const spec = sampleSpec(); spec.parameters.seed++;
  const job = { id: 'unsupported-input-job', kind: 'deployment', planId: 'policy-plan', planDigest: 'a'.repeat(64), spec, binding: { modelRoot: h.modelRoot } };
  const adapterRequest = makeAdapterRequest(job, cfg, directory, Date.now());
  let launched = false;
  await assert.rejects(runAdapter(cfg, {}, directory, adapterRequest, new AbortController().signal, { onLaunch: () => { launched = true; } }), { code: 'ADAPTER_INPUT_NOT_SUPPORTED' });
  assert.equal(launched, false);
  assert.deepEqual(await h.calls(), []);
});
