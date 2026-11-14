import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as bridge from '../plugins/npu-bridge/lib/index.js'
import { fixturePng } from './fixture-png.mjs'

const models = [
  { id: 'fixture-success', displayName: '测试图片 · 约 3 秒成功' },
  { id: 'fixture-failure', displayName: '测试错误 · 约 2 秒失败' },
  { id: 'fixture-slow', displayName: '测试慢任务 · 约 15 秒成功' },
].map(model => ({ ...model, tasks: ['text-to-image'], readiness: 'ready' }))
class RequestError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new RequestError(415, 'JSON_REQUIRED', 'Use application/json.')
  const chunks = []; let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 16384) throw new RequestError(413, 'REQUEST_TOO_LARGE', 'Request limit is 16 KiB.')
    chunks.push(part)
  }
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RequestError(400, 'INVALID_JSON', 'Invalid JSON.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RequestError(400, 'INVALID_REQUEST', 'Expected an object.')
  return parsed
}

/** In-memory loopback fixture; no weights, model API or NPU code is invoked. */
export async function startTestService({ port = 3081, queuedMs = 600, successMs = 3000, failureMs = 1800, slowMs = 15000 } = {}) {
  const jobs = new Map()
  const png = fixturePng()
  const ctx = new Context()
  let baseURL
  function snapshot(row) {
    const elapsed = Date.now() - row.created
    const duration = row.modelId === 'fixture-slow' ? slowMs : row.modelId === 'fixture-failure' ? failureMs : successMs
    const terminal = elapsed >= duration
    const status = terminal ? (row.modelId === 'fixture-failure' ? 'failed' : 'succeeded') : elapsed < queuedMs ? 'queued' : 'running'
    return { id: row.id, modelId: row.modelId, task: 'text-to-image', status, executionKind: 'simulation',
      artifacts: status === 'succeeded' ? [{ id: `${row.id}-image`, uri: `${baseURL}artifacts/${row.id}.png`, mimeType: 'image/png' }] : [],
      ...(status === 'failed' ? { error: { code: 'FIXTURE_FAILURE', message: '测试服务预设失败；未运行模型或 NPU。' } } : {}) }
  }
  const server = createServer(async (req, res) => {
    const requestId = randomUUID()
    res.setHeader('x-request-id', requestId)
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
    try {
      if (req.headers.host !== new URL(baseURL).host) throw new RequestError(403, 'INVALID_HOST', 'Use the loopback service address.')
      if (req.headers.origin && req.headers.origin !== new URL(baseURL).origin) throw new RequestError(403, 'INVALID_ORIGIN', 'Cross-origin requests are not accepted.')
      const url = new URL(req.url, baseURL)
      if (req.method === 'GET' && ['/health', '/ready'].includes(url.pathname)) return json(200, { status: 'ok', executionKind: 'simulation', modelExecution: 'not_run' })
      if (req.method === 'GET' && url.pathname === '/v1/capabilities') return json(200, { protocolVersion: 'calculet.npu/v1', backendId: 'loopback-contract-fixture', executionKind: 'simulation', models })
      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        const input = await body(req)
        if (!models.some(m => m.id === input.modelId) || input.task !== 'text-to-image' || typeof input.prompt !== 'string'
          || !input.prompt.trim() || input.prompt.length > 8000 || (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff))) {
          throw new RequestError(400, 'INVALID_REQUEST', 'Choose a fixture image model, nonempty prompt and optional uint32 seed.')
        }
        for (const [id, row] of jobs) if (Date.now() - row.created > 3600000) jobs.delete(id)
        if (jobs.size >= 100) throw new RequestError(429, 'FIXTURE_LIMIT', 'Fixture stores at most 100 jobs for one hour. Restart to clear.')
        const row = { id: randomUUID(), modelId: input.modelId, created: Date.now() }
        jobs.set(row.id, row)
        return json(202, snapshot(row))
      }
      const match = /^\/v1\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname)
      if (req.method === 'GET' && match) {
        const row = jobs.get(match[1])
        if (!row) throw new RequestError(404, 'JOB_NOT_FOUND', 'Fixture job not found; restarting the service clears jobs.')
        return json(200, snapshot(row))
      }
      const artifact = /^\/artifacts\/([A-Za-z0-9-]+)\.png$/.exec(url.pathname)
      if (req.method === 'GET' && artifact) {
        const row = jobs.get(artifact[1])
        if (!row || snapshot(row).status !== 'succeeded') throw new RequestError(404, 'ARTIFACT_NOT_READY', 'No successful test artifact for this job.')
        res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="test-fixture.png"` })
        return res.end(png)
      }
      const toolMatch = /^\/bridge\/tools\/(npu_status|npu_list_models|npu_generate|npu_get_job|npu_wait_job)$/.exec(url.pathname)
      if (req.method === 'POST' && toolMatch) {
        const args = await body(req)
        const controller = new AbortController()
        res.on('close', () => { if (!res.writableEnded) controller.abort() })
        const tool = ctx.tools.get(toolMatch[1])
        const value = await tool.execute(args, { signal: controller.signal })
        const content = tool.output.render(args, value)
        return json(200, { value, content })
      }
      if (req.method === 'GET' && ['/', '/workbench.js', '/workbench.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'workbench.html' : url.pathname.slice(1)
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        const bytes = await readFile(new URL(`./${file}`, import.meta.url))
        res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' })
        return res.end(bytes)
      }
      throw new RequestError(404, 'NOT_FOUND', 'Route not found.')
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) json(error.status ?? 400, { error: { code: error.code ?? 'TOOL_ERROR', message: error.message }, requestId })
    }
  })
  // Install the actual native plugin registry before accepting requests.
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(Tools).await()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  baseURL = `http://127.0.0.1:${server.address().port}/`
  try {
    await ctx.plugin(bridge, { backendURL: baseURL }).await()
  } catch (error) { server.close(); ctx.fiber.dispose(); throw error }
  return { baseURL, ctx, server, close: async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await ctx.fiber.dispose()
  } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CALCULET_TEST_PORT ?? 3081)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CALCULET_TEST_PORT must be 1–65535.')
  const service = await startTestService({ port })
  console.log(JSON.stringify({ event: 'test_service_ready', url: service.baseURL, executionKind: 'simulation', modelExecution: 'not_run' }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exitCode = 0 })
}
