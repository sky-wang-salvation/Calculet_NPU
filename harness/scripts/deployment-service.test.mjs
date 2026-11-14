import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as bridge from '../plugins/npu-bridge/lib/index.js'
import { harness, TOKEN } from '../deployment/test/helpers.mjs'

async function setup(t, options) {
  const fixture = await harness(t, options)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(Tools).await()
  await ctx.plugin(bridge, { backendURL: fixture.service.url, apiToken: TOKEN }).await()
  const signal = new AbortController().signal
  return { ...fixture, async call(name, args = {}) {
    const tool = ctx.tools.get(name)
    const value = await tool.execute(args, { signal })
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], `${name} output must match the native schema`)
    return { value, content: tool.output.render(args, value) }
  } }
}

test('native deployment tools reach the persistent service, register a simulated capability and generate again', async t => {
  const fixture = await setup(t)
  const { value: before } = await fixture.call('npu_list_models')
  assert.deepEqual(before.models, [])
  const { value: plan } = await fixture.call('npu_plan_deployment', { prompt: '  a red apple\n', seed: 42 })
  assert.equal(plan.status, 'ready'); assert.equal(plan.spec.parameters.prompt, 'a red apple')
  const apply = { planId: plan.id, planDigest: plan.planDigest, idempotencyKey: 'native-deployment-1' }
  const { value: submitted } = await fixture.call('npu_apply_deployment', apply)
  const { value: duplicate } = await fixture.call('npu_apply_deployment', apply)
  assert.equal(duplicate.id, submitted.id)
  const { value: result, content } = await fixture.call('npu_wait_deployment_job', { jobId: submitted.id, maxWaitMs: 60000, pollIntervalMs: 25 })
  assert.equal(result.completed, true, JSON.stringify(result))
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job))
  assert.equal(result.job.executionKind, 'simulation')
  assert.equal(result.job.evidence.source, 'validated_adapter_report')
  assert.equal(result.job.evidence.deviceExecution.status, 'simulated')
  assert.equal(result.job.evidence.numericValidation.status, 'not_run')
  assert.match(content[0].text, /实际 NPU 调用为零/)
  const image = result.job.artifacts.find(artifact => artifact.mimeType === 'image/png')
  const fetched = await fetch(image.uri, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(fetched.status, 200)
  assert.deepEqual([...new Uint8Array(await fetched.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const { value: available } = await fixture.call('npu_list_models')
  assert.equal(available.models.length, 1)
  assert.equal(available.models[0].id, 'sd35-qproj-hybrid-smoke-v1')
  const { value: generated } = await fixture.call('npu_generate', { modelId: available.models[0].id, task: 'text-to-image', prompt: 'a blue cup', seed: 7 })
  const { value: finished } = await fixture.call('npu_wait_job', { jobId: generated.id, maxWaitMs: 60000, pollIntervalMs: 25 })
  assert.equal(finished.job.status, 'succeeded'); assert.equal(finished.job.executionKind, 'simulation')
  assert.equal((await fixture.calls()).filter(event => event.event === 'start').length, 2, 'one deployment and one generation, without duplicate execution')
})

test('native tools preserve blocked plans and adapter failures rather than showing a successful deployment', async t => {
  const blocked = await setup(t, { config: { adapter: null } })
  const { value: plan } = await blocked.call('npu_plan_deployment', { prompt: 'a red apple' })
  assert.equal(plan.status, 'blocked'); assert.ok(plan.blockers.length > 0)
  const { value: blockedJob } = await blocked.call('npu_apply_deployment', { planId: plan.id, planDigest: plan.planDigest, idempotencyKey: 'blocked-1' })
  assert.equal(blockedJob.status, 'blocked'); assert.ok(blockedJob.error)
  assert.equal((await blocked.calls()).length, 0)
  await assert.rejects(blocked.call('npu_plan_deployment', { prompt: 'a red apple', requireFullNpu: true }), error => error.code === 'UNSUPPORTED_DEPLOYMENT_PROFILE')

  const failing = await setup(t, { mode: 'nonzero' })
  const { value: ready } = await failing.call('npu_plan_deployment', { prompt: 'a red apple' })
  const { value: job } = await failing.call('npu_apply_deployment', { planId: ready.id, planDigest: ready.planDigest, idempotencyKey: 'failure-1' })
  const { value: failed } = await failing.call('npu_wait_deployment_job', { jobId: job.id, maxWaitMs: 60000, pollIntervalMs: 25 })
  assert.equal(failed.completed, true); assert.notEqual(failed.job.status, 'succeeded')
  assert.ok(failed.job.error); assert.deepEqual(failed.job.artifacts, [])
})

test('rendered deployment artifact links can be opened without exposing or sending the API bearer token', async t => {
  const fixture = await setup(t)
  const { value: plan } = await fixture.call('npu_plan_deployment', { prompt: 'a red apple' })
  const { value: job } = await fixture.call('npu_apply_deployment', { planId: plan.id, planDigest: plan.planDigest, idempotencyKey: 'browser-1' })
  const { value: result } = await fixture.call('npu_wait_deployment_job', { jobId: job.id, maxWaitMs: 60000, pollIntervalMs: 25 })
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result))
  for (const artifact of result.job.artifacts) {
    assert.ok(!artifact.uri.includes(TOKEN))
    const response = await fetch(artifact.uri, { redirect: 'error' })
    assert.equal(response.status, 200, 'ordinary browser artifact navigation must work without the full API token')
  }
  const denied = await fetch(`${fixture.service.url}/v1/capabilities`)
  assert.equal(denied.status, 401, 'browser artifact access must not remove API authentication')
})
