import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NpuClient } from '../lib/client.js'
import { makeDeploymentSpec, parseTaskSpec, parseDeploymentPlan, parseDeploymentJob, DEPLOYMENT_PROTOCOL, DEPLOYMENT_PROFILE, DEPLOYMENT_STEPS, NPU_MODULE } from '../lib/deployment.js'
import { deploymentPlanMarkdown, deploymentJobMarkdown, deploymentWaitMarkdown } from '../lib/deployment-presentation.js'

const config = { backendURL: '', apiToken: '', timeoutMs: 1000, maxResponseBytes: 20000, maxPromptChars: 8000 }
const signal = () => new AbortController().signal
const input = { prompt: 'a red apple on a wooden table', seed: 42 }
const digest = 'a'.repeat(64)
const now = '2026-11-15T01:00:00.000Z'
const plan = () => ({ protocolVersion: DEPLOYMENT_PROTOCOL, id: 'plan-1', status: 'ready', planDigest: digest,
  spec: makeDeploymentSpec(input), steps: [...DEPLOYMENT_STEPS], blockers: [], expiresAt: '2099-01-01T00:00:00.000Z',
  scope: { executionMode: 'hybrid', npuModules: [NPU_MODULE], coreMigrationComplete: false, validationLevel: 'hybrid-smoke' } })
const baseJob = () => ({ protocolVersion: DEPLOYMENT_PROTOCOL, id: 'deploy-1', planId: 'plan-1', profileId: DEPLOYMENT_PROFILE,
  status: 'queued', phase: 'queued', executionKind: 'not_run', executionMode: 'hybrid', coreMigrationComplete: false,
  validationLevel: 'hybrid-smoke', artifacts: [], createdAt: now, updatedAt: now })
const success = () => ({ ...baseJob(), status: 'succeeded', phase: 'complete', executionKind: 'simulation', artifacts: [
  { id: 'preview', uri: '/artifacts/preview.png', mimeType: 'image/png' },
  { id: 'trace', uri: '/artifacts/trace.json', mimeType: 'application/json' },
  { id: 'evidence', uri: '/artifacts/evidence.json', mimeType: 'application/json' },
], evidence: {
  source: 'validated_adapter_report', level: 'hybrid-smoke',
  deviceExecution: { status: 'simulated', npuCallCount: 4, npuFallbackCount: 0, traceArtifactId: 'trace' },
  numericValidation: { status: 'not_run' },
  imageValidation: { status: 'passed', artifactId: 'preview', width: 256, height: 256 }, evidenceIndexArtifactId: 'evidence',
} })
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
async function fixture(t, handler, overrides = {}) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const backendURL = `http://127.0.0.1:${server.address().port}/`
  return { client: new NpuClient({ ...config, backendURL, ...overrides }), backendURL }
}
const code = expected => error => error.code === expected

test('deployment DSL fills explicit fixed-profile defaults and never downgrades unsupported requests', () => {
  const spec = makeDeploymentSpec(input)
  assert.equal(spec.parameters.width, 256); assert.equal(spec.parameters.steps, 4)
  assert.equal(spec.parameters.seed, 42); assert.equal(spec.constraints.requireFullNpu, false)
  assert.deepEqual(parseTaskSpec(spec), spec)
  for (const extra of [{ width: 1024 }, { steps: 20 }, { enableT5: true }, { requireFullNpu: true },
    { allowNpuComputeFallback: true }, { modelId: 'other-model' }, { profileId: 'unverified' }, { batch: 2 }, { guidanceScale: 7 }]) {
    assert.throws(() => makeDeploymentSpec({ ...input, ...extra }), code('UNSUPPORTED_DEPLOYMENT_PROFILE'))
  }
  for (const extra of [{ seed: -1 }, { seed: 2 ** 32 }, { prompt: ' ' }, { prompt: null }, { shell: 'anything' }]) {
    assert.throws(() => makeDeploymentSpec({ ...input, ...extra }), code('INVALID_REQUEST'))
  }
  assert.throws(() => makeDeploymentSpec({ prompt: 'x'.repeat(101) }, 100), code('INVALID_REQUEST'))
  assert.throws(() => parseTaskSpec({ ...spec, extra: true }), code('INVALID_BACKEND_RESPONSE'))
  assert.throws(() => parseTaskSpec({ ...spec, constraints: { ...spec.constraints, executionMode: 'full-npu' } }), code('INVALID_BACKEND_RESPONSE'))
})

test('plan parsing rejects false readiness, changed scope, malformed digests and unsupported protocol', () => {
  assert.equal(parseDeploymentPlan(plan()).status, 'ready')
  const blocked = { ...plan(), status: 'blocked', blockers: [{ code: 'ADAPTER_NOT_CONFIGURED', message: 'Not configured.' }] }
  assert.equal(parseDeploymentPlan(blocked).status, 'blocked')
  for (const row of [
    { ...plan(), status: 'blocked' }, { ...plan(), blockers: blocked.blockers },
    { ...plan(), planDigest: 'not-a-digest' }, { ...plan(), expiresAt: 'not-a-time' },
    { ...plan(), steps: ['run_arbitrary_shell'] },
    { ...plan(), scope: { ...plan().scope, coreMigrationComplete: true } },
  ]) assert.throws(() => parseDeploymentPlan(row), code('INVALID_BACKEND_RESPONSE'))
  assert.throws(() => parseDeploymentPlan({ ...plan(), protocolVersion: 'unknown' }), code('UNSUPPORTED_PROTOCOL'))
})

test('deployment parsing requires scoped evidence, genuine artifact references and explicit failure reasons', () => {
  const base = new URL('http://127.0.0.1:3001/')
  assert.equal(parseDeploymentJob(success(), base).executionKind, 'simulation')
  for (const row of [
    { ...success(), artifacts: [] }, { ...success(), evidence: undefined },
    { ...success(), artifacts: success().artifacts.slice(0, 1) },
    { ...success(), executionKind: 'not_run' }, { ...success(), coreMigrationComplete: true },
    { ...success(), validationLevel: 'production' }, { ...success(), phase: 'queued' },
    { ...success(), error: { code: 'FAILED', message: 'Contradiction.' } },
    { ...baseJob(), status: 'blocked' }, { ...baseJob(), status: 'reconciling' },
    { ...success(), artifacts: [{ ...success().artifacts[0], uri: 'https://other.example/preview.png' }, ...success().artifacts.slice(1)] },
    { ...success(), executionKind: 'hardware' },
    { ...success(), evidence: { ...success().evidence, deviceExecution: 'simulated' } },
    { ...success(), evidence: { ...success().evidence, deviceExecution: { ...success().evidence.deviceExecution, npuCallCount: 1 } } },
    { ...success(), evidence: { ...success().evidence, numericValidation: { status: 'passed' } } },
    { ...success(), evidence: { ...success().evidence, imageValidation: { ...success().evidence.imageValidation, width: 1024 } } },
  ]) assert.throws(() => parseDeploymentJob(row, base), code('INVALID_BACKEND_RESPONSE'))
})

test('unconfigured deployment refuses execution, and invalid inputs fail before network access', async () => {
  const client = new NpuClient(config)
  await assert.rejects(client.planDeployment(input, signal()), code('BACKEND_NOT_CONFIGURED'))
  await assert.rejects(client.applyDeployment({ planId: 'plan-1', planDigest: digest, idempotencyKey: 'key-1' }, signal()), code('BACKEND_NOT_CONFIGURED'))
  await assert.rejects(client.planDeployment({ ...input, requireFullNpu: true }, signal()), code('UNSUPPORTED_DEPLOYMENT_PROFILE'))
  await assert.rejects(client.applyDeployment({ planId: '../escape', planDigest: digest, idempotencyKey: 'key-1' }, signal()), code('INVALID_IDENTIFIER'))
  await assert.rejects(client.applyDeployment({ planId: 'plan-1', planDigest: 'bad', idempotencyKey: 'key-1' }, signal()), code('INVALID_REQUEST'))
  await assert.rejects(client.waitDeploymentJob('deploy-1', signal(), 60001, 100), code('INVALID_REQUEST'))
})

test('client plans and applies once, then waits through GET-only deployment queries', async t => {
  const calls = [], bodies = []
  let queries = 0
  const { client } = await fixture(t, async (req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
    }
    if (req.url === '/v1/deployment-plans') return json(res, plan())
    if (req.url === '/v1/deployment-jobs') return json(res, baseJob())
    json(res, ++queries === 1 ? { ...baseJob(), status: 'running', phase: 'run_validation', executionKind: 'simulation' } : success())
  })
  const proposal = await client.planDeployment(input, signal())
  const submitted = await client.applyDeployment({ planId: proposal.id, planDigest: proposal.planDigest, idempotencyKey: 'stable-1' }, signal())
  const result = await client.waitDeploymentJob(submitted.id, signal(), 1000, 10)
  assert.equal(result.completed, true); assert.equal(result.job.status, 'succeeded')
  assert.equal(result.job.executionKind, 'simulation'); assert.equal(result.job.artifacts.length, 3)
  assert.equal(result.job.evidence.deviceExecution.status, 'simulated')
  assert.deepEqual(bodies[0], { spec: makeDeploymentSpec(input) })
  assert.equal(bodies[1].idempotencyKey, 'stable-1')
  assert.deepEqual(calls.slice(0, 2), ['POST /v1/deployment-plans', 'POST /v1/deployment-jobs'])
  assert.ok(calls.slice(2).every(call => call === 'GET /v1/deployment-jobs/deploy-1'))
})

test('changed task specification or returned plan identity is rejected', async t => {
  let mode = 'spec'
  const { client } = await fixture(t, (_req, res) => json(res, mode === 'spec'
    ? { ...plan(), spec: makeDeploymentSpec({ ...input, seed: 99 }) } : { ...baseJob(), planId: 'other-plan' }))
  await assert.rejects(client.planDeployment(input, signal()), code('INVALID_BACKEND_RESPONSE'))
  mode = 'plan'
  await assert.rejects(client.applyDeployment({ planId: 'plan-1', planDigest: digest, idempotencyKey: 'key-1' }, signal()), code('INVALID_BACKEND_RESPONSE'))
  await assert.rejects(client.getDeploymentJob('different-job', signal()), code('INVALID_BACKEND_RESPONSE'))
})

test('prompt whitespace normalization agrees with the service without masking semantic changes', async t => {
  const { client } = await fixture(t, (_req, res) => json(res, plan()))
  const returned = await client.planDeployment({ ...input, prompt: `  ${input.prompt}\n` }, signal())
  assert.equal(returned.spec.parameters.prompt, input.prompt)
})

test('deployment waiting times out and resumes the same job without creating another', async t => {
  let done = false
  const { client } = await fixture(t, (req, res) => {
    assert.equal(req.method, 'GET'); json(res, done ? success() : baseJob())
  })
  const result = await client.waitDeploymentJob('deploy-1', signal(), 50, 10)
  assert.equal(result.timedOut, true); assert.equal(result.jobId, 'deploy-1')
  done = true
  assert.equal((await client.waitDeploymentJob(result.jobId, signal(), 1000, 10)).job.status, 'succeeded')
})

test('blocked and reconciling deployment states end a wait without being called success', async t => {
  let status = 'blocked'
  const { client } = await fixture(t, (_req, res) => json(res, { ...baseJob(), status, phase: status, error: { code: 'NEEDS_OPERATOR', message: 'Inspect retained job before another execution.' } }))
  for (const value of ['blocked', 'reconciling', 'failed']) {
    status = value
    const result = await client.waitDeploymentJob('deploy-1', signal(), 1000, 10)
    assert.equal(result.completed, true); assert.equal(result.job.status, value)
  }
})

test('deployment polling detects identity and execution-mode changes', async t => {
  let count = 0, mode = 'identity'
  const { client } = await fixture(t, (_req, res) => {
    const later = ++count > 1
    json(res, { ...baseJob(), status: 'running', phase: 'run_validation', executionKind: later && mode === 'execution' ? 'hardware' : 'simulation',
      planId: later && mode === 'identity' ? 'other-plan' : 'plan-1' })
  })
  for (const value of ['identity', 'execution']) {
    mode = value; count = 0
    const result = await client.waitDeploymentJob('deploy-1', signal(), 1000, 10)
    assert.equal(result.queryError.code, 'INVALID_BACKEND_RESPONSE')
    assert.equal(result.job.planId, 'plan-1'); assert.equal(result.job.executionKind, 'simulation')
  }
})

test('deployment presentation preserves smoke limits, simulation labels, blockers and recovery meaning', () => {
  const blocked = { ...plan(), status: 'blocked', blockers: [{ code: 'MISSING', message: '<script>not trusted</script>' }] }
  const text = deploymentPlanMarkdown(blocked)
  assert.match(text, /未启动模型/); assert.ok(!text.includes('<script>'))
  assert.match(deploymentJobMarkdown(success()), /非模型或 NPU 实测/)
  assert.match(deploymentJobMarkdown(success()), /完整核心迁移：否/)
  assert.match(deploymentWaitMarkdown({ jobId: 'deploy-1', completed: false, timedOut: true, elapsedMs: 50 }), /没有因此取消/)
})
