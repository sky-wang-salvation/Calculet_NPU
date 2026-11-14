import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NpuClient } from '../lib/client.js'
import { jobMarkdown, waitMarkdown } from '../lib/presentation.js'

const base = { id: 'job-1', modelId: 'fixture', task: 'text-to-image', status: 'queued', executionKind: 'simulation', artifacts: [] }
const artifact = { id: 'image-1', uri: '/artifacts/test.png', mimeType: 'image/png' }
const signal = () => new AbortController().signal
async function setup(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  return new NpuClient({ backendURL: `http://127.0.0.1:${server.address().port}/`, apiToken: '', timeoutMs: 500, maxResponseBytes: 10000, maxPromptChars: 8000 })
}
const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

test('polls queued and running to success using GET only and retains the artifact', async t => {
  const methods = [], states = ['queued', 'running', 'succeeded']
  const client = await setup(t, (req, res) => {
    methods.push(req.method)
    const status = states.shift()
    json(res, { ...base, status, artifacts: status === 'succeeded' ? [artifact] : [] })
  })
  const result = await client.waitJob('job-1', signal(), 1000, 10)
  assert.equal(result.completed, true); assert.equal(result.timedOut, false)
  assert.equal(result.job.status, 'succeeded'); assert.equal(result.job.artifacts[0].mimeType, 'image/png')
  assert.deepEqual(methods, ['GET', 'GET', 'GET'])
})

test('waiting expires without cancelling; the same job ID can resume', async t => {
  let done = false, requests = 0
  const client = await setup(t, (req, res) => {
    assert.equal(req.method, 'GET'); requests++
    json(res, { ...base, status: done ? 'succeeded' : 'running', artifacts: done ? [artifact] : [] })
  })
  const result = await client.waitJob('job-1', signal(), 65, 20)
  assert.equal(result.completed, false); assert.equal(result.timedOut, true); assert.equal(result.jobId, 'job-1')
  assert.equal(result.job.status, 'running'); assert.ok(requests >= 1)
  done = true
  assert.equal((await client.waitJob(result.jobId, signal(), 500, 10)).job.status, 'succeeded')
})

test('overall wait budget includes a stalled HTTP request', async t => {
  const client = await setup(t, () => {})
  const started = performance.now()
  const result = await client.waitJob('job-1', signal(), 60, 10)
  assert.equal(result.timedOut, true); assert.equal(result.jobId, 'job-1'); assert.equal(result.job, undefined)
  assert.ok(performance.now() - started < 450)
})

test('failed and cancelled are terminal states, not successful generation', async t => {
  let status = 'failed'
  const client = await setup(t, (_req, res) => json(res, { ...base, status, ...(status === 'failed' ? { error: { code: 'TEST_FAILURE', message: 'expected failure' } } : {}) }))
  const failed = await client.waitJob('job-1', signal(), 500, 10)
  assert.equal(failed.completed, true); assert.equal(failed.job.status, 'failed'); assert.equal(failed.job.artifacts.length, 0)
  status = 'cancelled'
  assert.equal((await client.waitJob('job-1', signal(), 500, 10)).job.status, 'cancelled')
})

test('caller cancellation stops polling promptly', async t => {
  let requests = 0
  const client = await setup(t, (_req, res) => { requests++; json(res, base) })
  const abort = new AbortController()
  const waiting = client.waitJob('job-1', abort.signal, 1000, 100)
  setTimeout(() => abort.abort(), 35)
  await assert.rejects(waiting, error => error.name === 'AbortError')
  const stoppedAt = requests
  await new Promise(resolve => setTimeout(resolve, 130))
  assert.equal(requests, stoppedAt)
})

test('query failure preserves ID and last snapshot, with no resubmission', async t => {
  let count = 0
  const client = await setup(t, (req, res) => {
    assert.equal(req.method, 'GET')
    if (++count === 1) return json(res, base)
    res.writeHead(503); res.end()
  })
  const result = await client.waitJob('job-1', signal(), 500, 10)
  assert.equal(result.queryError.code, 'BACKEND_HTTP_ERROR'); assert.equal(result.jobId, 'job-1')
  assert.equal(result.job.status, 'queued'); assert.equal(result.completed, false)
})

test('identity changes are rejected; not_run may transition to an actual execution mode', async t => {
  let count = 0
  const client = await setup(t, (_req, res) => {
    count++
    json(res, count === 1 ? { ...base, executionKind: 'not_run' }
      : count === 2 ? { ...base, status: 'running' } : { ...base, modelId: 'another-model' })
  })
  const result = await client.waitJob('job-1', signal(), 500, 10)
  assert.equal(result.queryError.code, 'INVALID_BACKEND_RESPONSE')
  assert.equal(result.job.modelId, 'fixture'); assert.equal(result.job.status, 'running')
})

test('invalid wait parameters fail before network I/O', async () => {
  const client = new NpuClient({ backendURL: '', apiToken: '', timeoutMs: 50, maxResponseBytes: 1000, maxPromptChars: 8000 })
  for (const args of [[0, 100], [60001, 100], [100, 0], [100, 10001]]) {
    await assert.rejects(client.waitJob('job-1', signal(), ...args), error => error.code === 'INVALID_REQUEST')
  }
})

test('presentation labels simulations, provides preview/download links and escapes backend labels', () => {
  const text = jobMarkdown({ ...base, modelId: '<img src=x onerror=alert(1)>', status: 'succeeded', artifacts: [{ ...artifact, uri: 'http://127.0.0.1:3081/artifacts/test.png' }] })
  assert.match(text, /测试／仿真模式/); assert.match(text, /打开／下载/); assert.match(text, /!\[/)
  assert.ok(!text.includes('<img'))
  assert.match(waitMarkdown({ jobId: 'job-1', completed: false, timedOut: true, elapsedMs: 10 }), /没有因此取消/)
})
