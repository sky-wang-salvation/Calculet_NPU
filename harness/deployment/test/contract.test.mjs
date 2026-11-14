import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskSpec, specForGeneration, buildPlan, canonicalJSON, digest, PROFILE_ID } from '../contract.mjs';
import { normalizeConfig } from '../config.mjs';
import { relativePath } from '../io.mjs';
import { crc32, validatePNG } from '../adapter.mjs';
import { sampleSpec } from './helpers.mjs';

test('PNG CRC uses the standard test vector and incomplete signatures fail', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => validatePNG(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), { code: 'INVALID_PNG' });
});

test('complete DSL normalizes prompt without mutating the input', () => {
  const input = sampleSpec(); input.parameters.prompt = '  literal --request /tmp/untrusted  ';
  const normalized = normalizeTaskSpec(input);
  assert.equal(normalized.parameters.prompt, 'literal --request /tmp/untrusted');
  assert.ok(input.parameters.prompt.startsWith('  '));
  assert.deepEqual(normalizeTaskSpec(normalized), normalized);
});

test('DSL rejects unknown fields, missing fields, types, and unsupported recipe changes', () => {
  const mutations = [
    s => { s.shell = 'bash'; }, s => { s.parameters.argv = ['x']; }, s => { delete s.intent; },
    s => { s.parameters.prompt = '   '; }, s => { s.parameters.prompt = 'x'.repeat(8001); },
    s => { s.parameters.prompt = 'x\0y'; }, s => { s.parameters.prompt = 1; },
    s => { s.parameters.seed = -1; }, s => { s.parameters.seed = 2 ** 32; }, s => { s.parameters.seed = 1.5; },
    s => { s.parameters.width = 512; }, s => { s.parameters.height = '256'; }, s => { s.parameters.steps = 28; },
    s => { s.parameters.batch = 2; }, s => { s.parameters.guidanceScale = 7; }, s => { s.parameters.enableT5 = true; },
    s => { s.constraints.requireFullNpu = true; }, s => { s.constraints.allowNpuComputeFallback = true; },
    s => { s.constraints.executionMode = 'npu'; }, s => { s.acceptance.level = 'quality'; },
    s => { s.profileId = 'other'; }, s => { s.modelId = 'other'; }, s => { s.schemaVersion = 'other'; },
    s => { s.acceptance = []; }, s => { s.parameters = null; },
  ];
  for (const mutate of mutations) { const spec = sampleSpec(); mutate(spec); assert.throws(() => normalizeTaskSpec(spec)); }
  for (const input of [null, [], 'text']) assert.throws(() => normalizeTaskSpec(input));
});

test('plan digest binds canonical DSL, recipe and private runtime identity', () => {
  const spec = sampleSpec();
  const binding = { scriptSha256: 'a'.repeat(64), authorization: 'operator-approved-window' };
  const p = buildPlan(spec, binding, [], { now: 1000, ttlMs: 1000, id: 'test-plan' });
  assert.equal(p.status, 'ready'); assert.match(p.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(p.expiresAt, new Date(2000).toISOString());
  assert.equal(p.planDigest, buildPlan(JSON.parse(JSON.stringify(spec)), binding).planDigest);
  assert.notEqual(p.planDigest, buildPlan(spec, { ...binding, scriptSha256: 'b'.repeat(64) }).planDigest);
  spec.parameters.seed++;
  assert.notEqual(p.planDigest, buildPlan(spec, binding).planDigest);
  assert.equal(buildPlan(spec, null, [{ code: 'ADAPTER_NOT_CONFIGURED', message: 'Missing.' }]).status, 'blocked');
  assert.ok(!JSON.stringify(p).includes('operator-approved-window'));
  assert.equal(canonicalJSON({ b: 2, a: { z: 1, x: ['中文', true] } }), '{"a":{"x":["中文",true],"z":1},"b":2}');
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test('generation compatibility only exposes literal prompt and seed', () => {
  const spec = specForGeneration({ modelId: PROFILE_ID, task: 'text-to-image', prompt: 'A literal prompt' });
  assert.equal(spec.parameters.seed, 20261115);
  assert.equal(spec.parameters.steps, 4);
  assert.throws(() => specForGeneration({ modelId: PROFILE_ID, task: 'text-to-video', prompt: 'x' }));
  assert.throws(() => specForGeneration({ modelId: PROFILE_ID, task: 'text-to-image', prompt: 'x', width: 512 }));
});

test('configuration rejects nonloopback bind, unknown keys, and dangerous path forms', () => {
  assert.throws(() => normalizeConfig({ listen: { host: '0.0.0.0' } }));
  assert.throws(() => normalizeConfig({ shell: true }));
  assert.throws(() => normalizeConfig({ apiTokenEnv: 'BAD=VALUE' }));
  assert.throws(() => normalizeConfig({ listen: { port: 1.1 } }));
  for (const input of ['../x', '/absolute', 'a/../x', 'a\\b', 'a//b', 'C:/x', 'a/CON.txt', 'a/x.', 'a/./b', 'a/']) assert.throws(() => relativePath(input));
  assert.equal(relativePath('artifacts/image.png'), 'artifacts/image.png');
});
