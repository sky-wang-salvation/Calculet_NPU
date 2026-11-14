import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { harness, request, rawRequest, plan, apply, waitJob, TOKEN, sampleSpec } from './helpers.mjs';
import { startService } from '../server.mjs';
import { validatePNG, makeAdapterRequest, runAdapter } from '../adapter.mjs';
import { normalizeConfig, inspectRuntime } from '../config.mjs';

const PROFILE = 'sd35-qproj-hybrid-smoke-v1';

test('no adapter is fail-closed; planning never launches a process', async t => {
  const h = await harness(t, { config: { adapter: null } });
  const p = await plan(h.service);
  assert.equal(p.status, 'blocked'); assert.equal(p.blockers[0].code, 'ADAPTER_NOT_CONFIGURED');
  const job = await apply(h.service, p);
  assert.equal(job.status, 202); assert.equal(job.body.status, 'blocked'); assert.equal(job.body.executionKind, 'not_run');
  assert.deepEqual((await request(h.service, 'GET', '/v1/capabilities')).body.models, []);
  assert.equal((await request(h.service, 'POST', '/v1/jobs', { modelId: PROFILE, task: 'text-to-image', prompt: 'hello' })).status, 409);
  assert.equal((await h.calls()).length, 0);
});

test('simulation deployment, evidence, PNG retrieval and generation v1 work end-to-end', async t => {
  const h = await harness(t);
  const p = await plan(h.service);
  assert.equal(p.status, 'ready', JSON.stringify(p.blockers));
  assert.equal((await h.calls()).length, 0);
  const submitted = await apply(h.service, p);
  assert.equal(submitted.status, 202);
  const completed = await waitJob(h.service, submitted.body.id);
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
  assert.equal(completed.executionKind, 'simulation');
  assert.equal(completed.phase, 'complete');
  assert.equal(completed.artifacts.find(artifact => artifact.id === 'evidence').mimeType, 'application/json');
  assert.equal(completed.coreMigrationComplete, false);
  assert.equal(completed.evidence.deviceExecution.status, 'simulated');
  assert.equal(completed.evidence.numericValidation.status, 'not_run');
  assert.equal(completed.evidence.source, 'validated_adapter_report');
  assert.equal(completed.artifacts.length, 3);
  const image = completed.artifacts.find(artifact => artifact.mimeType === 'image/png');
  assert.equal(new URL(image.uri).origin, h.service.url);
  const imageResponse = await fetch(image.uri, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(imageResponse.status, 200); assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  validatePNG(Buffer.from(await imageResponse.arrayBuffer()));
  assert.equal((await fetch(image.uri)).status, 200);
  assert.equal((await fetch(`${new URL(image.uri).origin}${new URL(image.uri).pathname}`)).status, 401);
  const capabilities = (await request(h.service, 'GET', '/v1/capabilities')).body;
  assert.equal(capabilities.executionKind, 'simulation'); assert.equal(capabilities.models[0].id, PROFILE);
  assert.equal(capabilities.scope.coreMigrationComplete, false);
  const generated = await request(h.service, 'POST', '/v1/jobs', { modelId: PROFILE, task: 'text-to-image', prompt: 'literal --request /untrusted ; do not interpret', seed: 0 }, { 'idempotency-key': 'generation-key' });
  assert.equal(generated.status, 202);
  const generation = await waitJob(h.service, generated.body.id, { generation: true });
  assert.equal(generation.status, 'succeeded', JSON.stringify(generation));
  assert.equal(generation.modelId, PROFILE); assert.equal(generation.executionKind, 'simulation');
  const savedRequest = JSON.parse(await readFile(path.join(h.config.storageDir, 'jobs', generation.id, 'request.json'), 'utf8'));
  assert.equal(savedRequest.spec.parameters.seed, 0);
  assert.equal(savedRequest.spec.parameters.width, 256);
  assert.match(savedRequest.spec.parameters.prompt, /^literal --request/);
  assert.equal(savedRequest.jobKind, 'generation');
  assert.equal(savedRequest.authorization, null);
  const replay = await request(h.service, 'POST', '/v1/jobs', { modelId: PROFILE, task: 'text-to-image', prompt: savedRequest.spec.parameters.prompt, seed: 0 }, { 'idempotency-key': 'generation-key' });
  assert.equal(replay.body.id, generation.id);
  const conflict = await request(h.service, 'POST', '/v1/jobs', { modelId: PROFILE, task: 'text-to-image', prompt: 'different' }, { 'idempotency-key': 'generation-key' });
  assert.equal(conflict.status, 409);
  assert.equal((await h.calls()).filter(call => call.event === 'start').length, 2);
});

test('concurrent same-key requests persist one job; different requests conflict', async t => {
  const h = await harness(t);
  const p = await plan(h.service);
  const responses = await Promise.all(Array.from({ length: 4 }, () => apply(h.service, p, 'stable-key')));
  assert.ok(responses.every(response => response.status === 202));
  assert.equal(new Set(responses.map(response => response.body.id)).size, 1);
  const completed = await waitJob(h.service, responses[0].body.id);
  assert.equal(completed.status, 'succeeded');
  const other = await plan(h.service, { ...sampleSpec(), parameters: { ...sampleSpec().parameters, seed: 7 } });
  const conflict = await apply(h.service, other, 'stable-key');
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await h.calls()).filter(call => call.event === 'start').length, 1);
});

test('expired plans and digest mismatches cannot execute', async t => {
  let now = Date.now();
  const h = await harness(t, { config: { adapter: null, planTtlMs: 100 }, clock: () => now });
  const p = await plan(h.service);
  const mismatch = await apply(h.service, { ...p, planDigest: 'a'.repeat(64) });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.error.code, 'PLAN_DIGEST_MISMATCH');
  now += 101;
  const expired = await apply(h.service, p);
  assert.equal(expired.status, 409); assert.equal(expired.body.error.code, 'PLAN_EXPIRED');
  assert.equal((await h.calls()).length, 0);
});

test('runtime file identity changes block application of a ready plan', async t => {
  const h = await harness(t);
  const p = await plan(h.service);
  await writeFile(path.join(h.modelRoot, 'manifest.json'), 'changed after planning');
  const response = await apply(h.service, p);
  assert.equal(response.body.status, 'blocked');
  assert.equal(response.body.error.code, 'COMPONENT_DIGEST_MISMATCH');
  assert.equal(response.body.executionKind, 'not_run'); assert.equal((await h.calls()).length, 0);
});

test('hardware requires operator window, coordination acknowledgment and cooperative lock', async t => {
  const h = await harness(t);
  await h.service.close();
  const hardware = { ...h.config.adapter, executionKind: 'hardware' };
  const service = await h.start({ adapter: hardware });
  let p = await plan(service);
  const codes = p.blockers.map(row => row.code);
  assert.ok(codes.includes('OPERATOR_AUTHORIZATION_REQUIRED')); assert.ok(codes.includes('RESOURCE_LOCK_REQUIRED'));
  assert.equal((await apply(service, p)).body.status, 'blocked');
  await service.close();
  const now = Date.now();
  const auth = { authorized: true, operatorId: 'offline-test-no-device', authorizationId: 'offline-test-window', resourceId: 'never-connected', sharedDeviceAcknowledged: true, windowStart: new Date(now - 1000).toISOString(), windowEnd: new Date(now + 60000).toISOString() };
  const lock = path.join(h.root, 'device.lock');
  await writeFile(lock, JSON.stringify({ token: 'another-holder' }));
  const locked = await h.start({ adapter: hardware, operatorAuthorization: auth, resourceLockPath: lock });
  p = await plan(locked);
  assert.equal(p.status, 'blocked'); assert.ok(p.blockers.some(row => row.code === 'RESOURCE_BUSY'));
  await locked.close();
  const expired = await h.start({ adapter: hardware, operatorAuthorization: { ...auth, windowStart: new Date(now - 60000).toISOString(), windowEnd: new Date(now - 1).toISOString() }, resourceLockPath: lock });
  p = await plan(expired);
  assert.ok(p.blockers.some(row => row.code === 'AUTHORIZATION_WINDOW_CLOSED'));
  assert.equal((await h.calls()).length, 0);
});

test('authorization is checked after identity I/O and again immediately before launch', async t => {
  const h = await harness(t);
  await h.service.close();
  const initial = Date.now();
  const expires = initial + 60000;
  let now = initial;
  const cfg = normalizeConfig({
    ...h.config, adapter: { ...h.config.adapter, executionKind: 'hardware' },
    resourceLockPath: path.join(h.root, 'never-acquired-device.lock'),
    operatorAuthorization: { authorized: true, operatorId: 'offline-test', authorizationId: 'offline-window', resourceId: 'no-device', sharedDeviceAcknowledged: true, windowStart: new Date(initial - 1000).toISOString(), windowEnd: new Date(expires).toISOString() },
  });
  const checking = inspectRuntime(cfg, {}, () => now);
  now = expires + 1;
  const inspection = await checking;
  assert.ok(inspection.blockers.some(row => row.code === 'AUTHORIZATION_WINDOW_CLOSED'));
  const directory = path.join(h.root, 'prelaunch-check');
  await mkdir(directory); await mkdir(path.join(directory, 'artifacts'));
  const job = { id: 'prelaunch-test', kind: 'deployment', planId: 'prelaunch-plan', planDigest: 'a'.repeat(64), spec: sampleSpec(), binding: { modelRoot: h.modelRoot } };
  const adapterRequest = makeAdapterRequest(job, cfg, directory, initial);
  let launched = false;
  await assert.rejects(runAdapter(cfg, {}, directory, adapterRequest, new AbortController().signal, { clock: () => now, onLaunch: () => { launched = true; } }), { code: 'AUTHORIZATION_WINDOW_CLOSED' });
  assert.equal(launched, false);
  assert.deepEqual(await h.calls(), []);
});

test('optional numeric metrics stay explicitly within simulation evidence', async t => {
  const h = await harness(t, { mode: 'numeric-passed' });
  const p = await plan(h.service);
  const response = await apply(h.service, p);
  const done = await waitJob(h.service, response.body.id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  assert.equal(done.executionKind, 'simulation');
  assert.equal(done.evidence.numericValidation.status, 'passed');
  assert.equal(done.evidence.numericValidation.metricsArtifactId, 'metrics');
  assert.equal(done.evidence.deviceExecution.status, 'simulated');
  assert.equal(done.artifacts.length, 4);
});

test('HTTP authentication, loopback host, Origin, media types, body size and JSON are enforced', async t => {
  const h = await harness(t, { config: { adapter: null, maxRequestBytes: 1024 } });
  assert.equal((await request(h.service, 'GET', '/v1/capabilities', undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await rawRequest(h.service, '/v1/capabilities', { host: 'attacker.example' })).status, 400);
  assert.equal((await request(h.service, 'GET', '/v1/capabilities', undefined, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await request(h.service, 'POST', '/v1/deployment-plans', '{bad-json')).status, 400);
  assert.equal((await request(h.service, 'POST', '/v1/deployment-plans', 'x'.repeat(1025))).status, 413);
  assert.equal((await request(h.service, 'POST', '/v1/deployment-plans', '{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request(h.service, 'POST', '/v1/deployment-plans', '{}', { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await request(h.service, 'POST', '/v1/deployment-plans', { spec: sampleSpec(), executable: 'not allowed' })).status, 400);
  await h.service.close();
  const missingToken = await h.start({}, {});
  assert.equal((await request(missingToken, 'GET', '/v1/capabilities')).body.error.code, 'AUTH_NOT_CONFIGURED');
});

test('successful artifacts are rehashed at retrieval and capability publication', async t => {
  const h = await harness(t);
  const p = await plan(h.service);
  const submitted = await apply(h.service, p);
  const done = await waitJob(h.service, submitted.body.id);
  assert.equal(done.status, 'succeeded');
  await writeFile(path.join(h.config.storageDir, 'jobs', done.id, 'artifacts', 'image.png'), 'tampered');
  const artifact = done.artifacts.find(row => row.id === 'image');
  const response = await fetch(artifact.uri, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ARTIFACT_CHANGED');
  assert.deepEqual((await request(h.service, 'GET', '/v1/capabilities')).body.models, []);
});

test('persistent storage has a single process owner and rejects corrupt state', async t => {
  const h = await harness(t, { config: { adapter: null } });
  await assert.rejects(startService({ config: h.config, env: { CALCULET_DEPLOY_TOKEN: TOKEN } }), { code: 'SERVICE_LOCKED' });
  await h.service.close();
  await writeFile(path.join(h.config.storageDir, 'state.json'), '{corrupt');
  await assert.rejects(startService({ config: h.config, env: { CALCULET_DEPLOY_TOKEN: TOKEN } }), { code: 'STATE_CORRUPT' });
});

test('shutdown and restart reconcile unfinished work without duplicate execution', async t => {
  const h = await harness(t, { mode: 'slow' });
  const p = await plan(h.service);
  const first = await apply(h.service, p, 'restart-first');
  await waitJob(h.service, first.body.id, { until: row => row.phase === 'run_validation' });
  while (!(await h.calls()).some(call => call.event === 'start')) await delay(20);
  const second = await apply(h.service, p, 'restart-second');
  await h.service.close();
  const restarted = await h.start();
  const recoveredFirst = await apply(restarted, p, 'restart-first');
  const recoveredSecond = await apply(restarted, p, 'restart-second');
  assert.equal(recoveredFirst.body.id, first.body.id); assert.equal(recoveredFirst.body.status, 'reconciling');
  assert.equal(recoveredSecond.body.id, second.body.id); assert.equal(recoveredSecond.body.status, 'reconciling');
  await delay(100);
  assert.equal((await h.calls()).filter(call => call.event === 'start').length, 1);
  assert.deepEqual((await request(restarted, 'GET', '/v1/capabilities')).body.models, []);
});

test('cold load reconciles persisted queued/running records and preserves idempotency', async t => {
  const h = await harness(t);
  const p = await plan(h.service);
  const a = await apply(h.service, p, 'cold-running');
  assert.equal((await waitJob(h.service, a.body.id)).status, 'succeeded');
  const b = await apply(h.service, p, 'cold-queued');
  assert.equal((await waitJob(h.service, b.body.id)).status, 'succeeded');
  await h.service.close();
  const file = path.join(h.config.storageDir, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.jobs[0].status = 'running'; state.jobs[0].phase = 'run_validation';
  state.jobs[1].status = 'queued'; state.jobs[1].phase = 'queued';
  state.capability = null;
  await writeFile(file, JSON.stringify(state));
  const restarted = await h.start();
  for (const key of ['cold-running', 'cold-queued']) {
    const response = await apply(restarted, p, key);
    assert.equal(response.body.status, 'reconciling');
    assert.equal(response.body.error.code, 'RESTART_RECONCILIATION_REQUIRED');
  }
  await delay(100);
  assert.equal((await h.calls()).filter(call => call.event === 'start').length, 2);
});

test('successful capability and idempotency survive a clean restart with new origin', async t => {
  const h = await harness(t);
  const p = await plan(h.service);
  const submitted = await apply(h.service, p, 'survive');
  assert.equal((await waitJob(h.service, submitted.body.id)).status, 'succeeded');
  await h.service.close();
  const restarted = await h.start();
  const same = await apply(restarted, p, 'survive');
  assert.equal(same.body.id, submitted.body.id); assert.equal(same.body.status, 'succeeded');
  assert.ok(same.body.artifacts.every(row => new URL(row.uri).origin === restarted.url));
  assert.equal((await request(restarted, 'GET', '/v1/capabilities')).body.executionKind, 'simulation');
  assert.equal((await h.calls()).filter(call => call.event === 'start').length, 1);
});

test('serial queue executes one child at a time', async t => {
  const h = await harness(t, { mode: 'delayed' });
  const p = await plan(h.service);
  const jobs = await Promise.all(['serial-1', 'serial-2', 'serial-3'].map(key => apply(h.service, p, key)));
  for (const row of jobs) assert.equal((await waitJob(h.service, row.body.id)).status, 'succeeded');
  const calls = await h.calls();
  assert.deepEqual(calls.map(row => row.event), ['start', 'end', 'start', 'end', 'start', 'end']);
});

test('queued jobs exhaust waiting budget without starting a second child', async t => {
  const h = await harness(t, { mode: 'delayed', config: { queueWaitTimeoutMs: 250 } });
  const p = await plan(h.service);
  const first = await apply(h.service, p, 'wait-first');
  await waitJob(h.service, first.body.id, { until: row => row.phase === 'run_validation' });
  const second = await apply(h.service, p, 'wait-second');
  assert.equal((await waitJob(h.service, first.body.id)).status, 'succeeded');
  const exhausted = await waitJob(h.service, second.body.id);
  assert.equal(exhausted.status, 'blocked'); assert.equal(exhausted.error.code, 'QUEUE_WAIT_TIMEOUT');
  assert.equal(exhausted.executionKind, 'not_run');
  assert.equal((await h.calls()).filter(call => call.event === 'start').length, 1);
});

test('adversarial simulation result fixtures never register a capability', async t => {
  const cases = [
    ['nonzero', 'ADAPTER_EXIT_NONZERO'], ['missing-result', 'ADAPTER_RESULT_MISSING'], ['malformed', 'ADAPTER_PROTOCOL_ERROR'],
    ['wrong-schema', 'ADAPTER_PROTOCOL_ERROR'], ['wrong-request', 'RESULT_IDENTITY_MISMATCH'], ['forged-digest', 'RESULT_IDENTITY_MISMATCH'],
    ['mode-mismatch', 'MODE_MISMATCH'], ['scope-mismatch', 'MODE_MISMATCH'], ['device-mode-mismatch', 'MODE_MISMATCH'],
    ['wrong-callcount', 'ADAPTER_PROTOCOL_ERROR'], ['fallback', 'ADAPTER_PROTOCOL_ERROR'], ['numeric-failed', 'NUMERIC_VALIDATION_FAILED'],
    ['missing-evidence', 'ADAPTER_PROTOCOL_ERROR'], ['missing-trace', 'ADAPTER_PROTOCOL_ERROR'], ['empty-trace', 'ADAPTER_PROTOCOL_ERROR'],
    ['traversal', 'UNSAFE_PATH'], ['absolute-path', 'UNSAFE_PATH'], ['symlink-escape', 'UNSAFE_PATH'],
    ['wrong-hash', 'ARTIFACT_DIGEST_MISMATCH'], ['invalid-png', 'INVALID_PNG'], ['index-mismatch', 'ADAPTER_PROTOCOL_ERROR'],
    ['missing-file', 'ADAPTER_PROTOCOL_ERROR'], ['request-tamper', 'REQUEST_CHANGED'], ['extra-field', 'ADAPTER_PROTOCOL_ERROR'],
  ];
  for (const [mode, code] of cases) await t.test(mode, async sub => {
    const h = await harness(sub, { mode });
    const p = await plan(h.service);
    const response = await apply(h.service, p);
    const done = await waitJob(h.service, response.body.id);
    assert.equal(done.status, 'failed', JSON.stringify(done));
    assert.equal(done.error.code, code, JSON.stringify(done));
    assert.deepEqual(done.artifacts, []);
    assert.equal((await request(h.service, 'GET', '/v1/capabilities')).body.executionKind, 'not_run');
  });
});

test('process timeout and output budget are enforced and never retried', async t => {
  for (const mode of ['slow', 'noisy']) await t.test(mode, async sub => {
    const h = await harness(sub, { mode });
    await h.service.close();
    const service = await h.start({ adapter: { ...h.config.adapter, timeoutMs: mode === 'slow' ? 1000 : 5000, maxOutputBytes: 1024 } });
    const p = await plan(service);
    const response = await apply(service, p, 'bounded-run');
    const done = await waitJob(service, response.body.id);
    assert.equal(done.status, 'failed', JSON.stringify(done));
    assert.equal(done.error.code, mode === 'slow' ? 'ADAPTER_TIMEOUT' : 'ADAPTER_OUTPUT_LIMIT');
    const replay = await apply(service, p, 'bounded-run');
    assert.equal(replay.body.id, done.id);
    assert.equal((await h.calls()).filter(call => call.event === 'start').length, 1);
  });
});
