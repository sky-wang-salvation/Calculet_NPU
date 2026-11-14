import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestService } from './test-service.mjs'

async function fixture(t) {
  const service = await startTestService({ port: 0, queuedMs: 25, successMs: 120, failureMs: 70, slowMs: 300 })
  t.after(() => service.close())
  const tool = async (name, args = {}) => {
    const response = await fetch(`${service.baseURL}bridge/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
    assert.equal(response.status, 200)
    return response.json()
  }
  return { ...service, tool }
}
test('real registered tools submit, wait, render and download the fixture PNG', async t => {
  const service = await fixture(t)
  assert.equal((await service.tool('npu_status')).value.executionKind, 'simulation')
  assert.equal((await service.tool('npu_list_models')).value.models.length, 3)
  const { value: job } = await service.tool('npu_generate', { modelId: 'fixture-success', task: 'text-to-image', prompt: 'test only', seed: 42 })
  assert.equal(job.status, 'queued')
  const { value, content } = await service.tool('npu_wait_job', { jobId: job.id, maxWaitMs: 2000, pollIntervalMs: 20 })
  assert.equal(value.completed, true); assert.equal(value.job.status, 'succeeded')
  assert.match(content[0].text, /测试／仿真模式/); assert.match(content[0].text, /打开／下载/)
  const image = await fetch(value.job.artifacts[0].uri)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const download = await fetch(`${value.job.artifacts[0].uri}?download=1`)
  assert.match(download.headers.get('content-disposition'), /attachment/)
})
test('native wait returns expected failure, and short waiting can resume a slow job', async t => {
  const { tool } = await fixture(t)
  const input = { task: 'text-to-image', prompt: 'test only' }
  const failed = (await tool('npu_generate', { ...input, modelId: 'fixture-failure' })).value
  const failure = (await tool('npu_wait_job', { jobId: failed.id, maxWaitMs: 1000, pollIntervalMs: 20 })).value
  assert.equal(failure.job.status, 'failed'); assert.equal(failure.job.error.code, 'FIXTURE_FAILURE')
  const slow = (await tool('npu_generate', { ...input, modelId: 'fixture-slow' })).value
  const paused = (await tool('npu_wait_job', { jobId: slow.id, maxWaitMs: 50, pollIntervalMs: 20 })).value
  assert.equal(paused.timedOut, true); assert.equal(paused.jobId, slow.id)
  const resumed = (await tool('npu_wait_job', { jobId: slow.id, maxWaitMs: 1000, pollIntervalMs: 20 })).value
  assert.equal(resumed.job.status, 'succeeded')
})
test('test service rejects cross-origin requests, invalid input and unavailable artifacts', async t => {
  const { baseURL } = await fixture(t)
  const post = headers => fetch(`${baseURL}v1/jobs`, { method: 'POST', headers, body: '{}' })
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'https://example.com' })).status, 403)
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 400)
  assert.equal((await fetch(`${baseURL}artifacts/missing.png`)).status, 404)
  assert.equal((await fetch(`${baseURL}health`)).status, 200)
})
