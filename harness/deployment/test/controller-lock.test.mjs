import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { normalizeConfig, inspectRuntime } from '../config.mjs';
import { makeAdapterRequest, runAdapter } from '../adapter.mjs';
import { buildPlan, digest, normalizeTaskSpec } from '../contract.mjs';
import { harness, sampleSpec, plan, apply, waitJob } from './helpers.mjs';

function job(h, binding) {
  return { id: 'controller-lock-job', kind: 'deployment', planId: 'controller-lock-plan', planDigest: 'a'.repeat(64), spec: sampleSpec(), binding: binding ?? { modelRoot: h.modelRoot } };
}

test('simulation requests explicitly carry null controllerLockPath and do not acquire a configured hardware lock', async t => {
  const h = await harness(t);
  await h.service.close();
  const unused = path.join(h.root, 'unused-simulation-device.lock');
  const service = await h.start({ resourceLockPath: unused });
  const p = await plan(service);
  const submitted = await apply(service, p);
  const completed = await waitJob(service, submitted.body.id);
  assert.equal(completed.status, 'succeeded');
  const request = JSON.parse(await readFile(path.join(h.config.storageDir, 'jobs', completed.id, 'request.json'), 'utf8'));
  assert.equal(Object.hasOwn(request.paths, 'controllerLockPath'), true);
  assert.equal(request.paths.controllerLockPath, null);
  await assert.rejects(lstat(unused), { code: 'ENOENT' });
});

test('hardware controllerLockPath comes from bound service configuration and is covered by both digests', async t => {
  const h = await harness(t);
  const firstPath = path.join(h.root, 'first-controller.lock');
  const cfg = normalizeConfig({ ...h.config, adapter: { ...h.config.adapter, executionKind: 'hardware' }, resourceLockPath: firstPath });
  const inspected = await inspectRuntime(cfg, {});
  assert.ok(inspected.blockers.some(blocker => blocker.code === 'OPERATOR_AUTHORIZATION_REQUIRED'));
  assert.equal(inspected.binding.resourceLockPath, firstPath);
  const request = makeAdapterRequest(job(h, inspected.binding), cfg, path.join(h.root, 'no-hardware-run'), Date.now());
  assert.equal(request.paths.controllerLockPath, cfg.resourceLockPath);
  assert.equal(request.paths.controllerLockPath, inspected.binding.resourceLockPath);
  const { requestDigest, ...unsigned } = structuredClone(request);
  assert.equal(digest(unsigned), requestDigest);
  unsigned.paths.controllerLockPath = path.join(h.root, 'altered-controller.lock');
  assert.notEqual(digest(unsigned), requestDigest);
  const secondCfg = normalizeConfig({ ...h.config, adapter: { ...h.config.adapter, executionKind: 'hardware' }, resourceLockPath: path.join(h.root, 'second-controller.lock') });
  const second = await inspectRuntime(secondCfg, {});
  assert.notEqual(buildPlan(sampleSpec(), inspected.binding, inspected.blockers).planDigest, buildPlan(sampleSpec(), second.binding, second.blockers).planDigest);
  assert.throws(() => normalizeTaskSpec({ ...sampleSpec(), controllerLockPath: firstPath }));
  assert.throws(() => normalizeTaskSpec({ ...sampleSpec(), parameters: { ...sampleSpec().parameters, controllerLockPath: firstPath } }));
  await assert.rejects(lstat(firstPath), { code: 'ENOENT' });
  assert.deepEqual(await h.calls(), []);
});

test('hardware request construction fails closed without an approved absolute controller lock path', async t => {
  const h = await harness(t);
  const cfg = normalizeConfig({ ...h.config, adapter: { ...h.config.adapter, executionKind: 'hardware' } });
  for (const resourceLockPath of [null, 'relative.lock']) {
    assert.throws(() => makeAdapterRequest(job(h), { ...cfg, resourceLockPath }, path.join(h.root, 'not-created'), Date.now()), { code: 'RESOURCE_LOCK_REQUIRED' });
  }
  assert.deepEqual(await h.calls(), []);
});

test('the simulation fixture rejects missing or nonnull controllerLockPath before generating files', async t => {
  const h = await harness(t);
  const cfg = normalizeConfig(h.config);
  for (const mode of ['missing', 'nonnull']) {
    const directory = path.join(h.root, `invalid-controller-${mode}`);
    await mkdir(directory); await mkdir(path.join(directory, 'artifacts'));
    const request = makeAdapterRequest(job(h), cfg, directory, Date.now());
    if (mode === 'missing') delete request.paths.controllerLockPath;
    else request.paths.controllerLockPath = path.join(h.root, 'not-a-simulation-lock');
    const { requestDigest: _oldDigest, ...unsigned } = request;
    request.requestDigest = digest(unsigned);
    await assert.rejects(runAdapter(cfg, {}, directory, request, new AbortController().signal), { code: 'ADAPTER_EXIT_NONZERO' });
    await assert.rejects(lstat(path.join(directory, 'artifacts', 'image.png')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(directory, 'result.json')), { code: 'ENOENT' });
  }
  assert.deepEqual(await h.calls(), []);
});
