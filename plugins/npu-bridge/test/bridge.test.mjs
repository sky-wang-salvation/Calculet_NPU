import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NpuClient } from '../lib/client.js'
import { parseCapabilities, parseJob, PROTOCOL_VERSION } from '../lib/protocol.js'

const signal = () => new AbortController().signal
const config = { backendURL: '', apiToken: '', timeoutMs: 1000, maxResponseBytes: 10000, maxPromptChars: 8000 }
const capabilities = {
  protocolVersion: PROTOCOL_VERSION, backendId: 'test-fixture', executionKind: 'simulation',
  models: [{ id: 'fixture-model', displayName: 'HTTP contract test only', tasks: ['text-to-image'], readiness: 'ready' }],
}
const input = { modelId: 'fixture-model', task: 'text-to-image', prompt: 'contract test' }
const job = {
  id: 'job-1', modelId: 'fixture-model', task: 'text-to-image', status: 'succeeded', executionKind: 'simulation',
  artifacts: [{ id: 'artifact-1', uri: '/test-artifact.png', mimeType: 'image/png' }],
}

async function fixture(t, handler, overrides = {}) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const backendURL = `http://127.0.0.1:${server.address().port}/`
  return new NpuClient({ ...config, backendURL, ...overrides })
}
function json(res, value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
function code(expected) { return error => error.code === expected }

test('unconfigured backend refuses generation; no demo success', async () => {
  const client = new NpuClient(config)
  assert.equal(client.configured, false)
  await assert.rejects(client.generate(input, signal()), code('BACKEND_NOT_CONFIGURED'))
  assert.throws(() => new NpuClient({ ...config, backendURL: 'bad URL' }), code('INVALID_CONFIGURATION'))
  assert.throws(() => new NpuClient({ ...config, backendURL: 'https://user:pass@example.com' }), code('INVALID_CONFIGURATION'))
})

test('test fixture roundtrip preserves simulation and exact request', async t => {
  let submitted
  const client = await fixture(t, async (req, res) => {
    if (req.url === '/v1/capabilities') return json(res, capabilities)
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      submitted = JSON.parse(Buffer.concat(chunks).toString()); return json(res, job)
    }
    if (req.url === '/v1/jobs/job-1') return json(res, job)
    res.writeHead(404); res.end()
  })
  const result = await client.generate({ ...input, seed: 42 }, signal())
  assert.deepEqual(submitted, { ...input, seed: 42 })
  assert.equal(result.executionKind, 'simulation')
  assert.equal((await client.getJob('job-1', signal())).id, 'job-1')
})

test('testing model and inactive backend cannot accept a generation', async t => {
  let posts = 0
  let declaration = { ...capabilities, models: [{ ...capabilities.models[0], readiness: 'testing' }] }
  const client = await fixture(t, (req, res) => { if (req.method === 'POST') posts++; json(res, declaration) })
  await assert.rejects(client.generate(input, signal()), code('MODEL_NOT_READY'))
  declaration = { ...capabilities, executionKind: 'not_run' }
  await assert.rejects(client.generate(input, signal()), code('BACKEND_NOT_READY'))
  assert.equal(posts, 0)
})

test('validation blocks invalid inputs before network', async () => {
  const client = new NpuClient(config)
  await assert.rejects(client.generate({ ...input, seed: -1 }, signal()), code('INVALID_REQUEST'))
  await assert.rejects(client.generate({ ...input, prompt: ' ' }, signal()), code('INVALID_REQUEST'))
  await assert.rejects(client.generate({ ...input, task: 'image-to-video' }, signal()), code('INVALID_REQUEST'))
  await assert.rejects(client.getJob('../other', signal()), code('INVALID_IDENTIFIER'))
})

test('rejects malformed protocols and false successful jobs', () => {
  assert.throws(() => parseCapabilities({ ...capabilities, protocolVersion: 'unknown' }), code('UNSUPPORTED_PROTOCOL'))
  assert.throws(() => parseCapabilities({ ...capabilities, models: [...capabilities.models, ...capabilities.models] }), code('INVALID_BACKEND_RESPONSE'))
  const base = new URL('http://127.0.0.1:1234/')
  for (const result of [
    { ...job, artifacts: [] }, { ...job, executionKind: 'not_run' },
    { ...job, status: 'failed' },
    { ...job, artifacts: [{ ...job.artifacts[0], uri: 'https://other.example/image.png' }] },
    { ...job, artifacts: [{ ...job.artifacts[0], uri: 'http://[bad' }] },
  ]) assert.throws(() => parseJob(result, base), code('INVALID_BACKEND_RESPONSE'))
})

test('rejects backend job model mismatch', async t => {
  const client = await fixture(t, (req, res) => json(res, req.url === '/v1/capabilities' ? capabilities : { ...job, modelId: 'other' }))
  await assert.rejects(client.generate(input, signal()), code('INVALID_BACKEND_RESPONSE'))
  await assert.rejects(client.getJob('different-id', signal()), code('INVALID_BACKEND_RESPONSE'))
})

test('bounds JSON responses and rejects malformed content', async t => {
  let mode = 'oversized'
  const client = await fixture(t, (req, res) => {
    if (mode === 'oversized') return json(res, { padding: 'x'.repeat(500) })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{broken')
  }, { maxResponseBytes: 100 })
  await assert.rejects(client.capabilities(signal()), code('RESPONSE_TOO_LARGE'))
  mode = 'malformed'
  await assert.rejects(client.capabilities(signal()), code('INVALID_BACKEND_RESPONSE'))
})

test('timeout, caller cancellation, and HTTP failure remain failures', async t => {
  let mode = 'timeout'
  const client = await fixture(t, (req, res) => { if (mode === 'http') { res.writeHead(503); res.end() } }, { timeoutMs: 50 })
  await assert.rejects(client.capabilities(signal()), code('BACKEND_TIMEOUT'))
  mode = 'http'
  await assert.rejects(client.capabilities(signal()), code('BACKEND_HTTP_ERROR'))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(client.capabilities(abort.signal), error => error.name === 'AbortError')
})

test('interrupted JSON body becomes a stable bridge failure', async t => {
  const client = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
    res.write('{')
    setTimeout(() => res.destroy(), 10)
  })
  await assert.rejects(client.capabilities(signal()), code('INVALID_BACKEND_RESPONSE'))
})
