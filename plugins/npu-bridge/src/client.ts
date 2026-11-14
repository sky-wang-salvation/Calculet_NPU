import { BridgeError, identifier, parseCapabilities, parseJob } from './protocol.js'
import type { Capabilities, GenerateRequest, Job } from './protocol.js'

export interface BackendConfig {
  backendURL: string
  apiToken: string
  timeoutMs: number
  maxResponseBytes: number
  maxPromptChars: number
}

/** HTTP access to a user-configured service; no implicit demo or cloud backend. */
export class NpuClient {
  private readonly base: URL | undefined

  constructor(private readonly config: BackendConfig) {
    if (config.backendURL.length > 0) {
      let url: URL
      try { url = new URL(config.backendURL) }
      catch { throw new BridgeError('INVALID_CONFIGURATION', 'backendURL must be an absolute HTTP(S) URL.') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new BridgeError('INVALID_CONFIGURATION', 'Use an HTTP(S) service URL without credentials, query, or fragment.')
      }
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      this.base = url
    }
  }

  get configured(): boolean { return this.base !== undefined }

  async capabilities(signal: AbortSignal): Promise<Capabilities> {
    return parseCapabilities(await this.request('v1/capabilities', signal))
  }

  async generate(input: GenerateRequest, signal: AbortSignal): Promise<Job> {
    if (input.prompt.trim().length === 0 || input.prompt.length > this.config.maxPromptChars) {
      throw new BridgeError('INVALID_REQUEST', 'Provide a nonempty prompt within the configured length limit.')
    }
    if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffff_ffff)) {
      throw new BridgeError('INVALID_REQUEST', 'seed must be an unsigned 32-bit integer.')
    }
    if (input.task === 'image-to-video') {
      if (input.inputArtifactId === undefined) throw new BridgeError('INVALID_REQUEST', 'image-to-video requires inputArtifactId.')
      identifier(input.inputArtifactId)
    } else if (input.inputArtifactId !== undefined) {
      throw new BridgeError('INVALID_REQUEST', 'inputArtifactId applies only to image-to-video.')
    }
    const capabilities = await this.capabilities(signal)
    const model = capabilities.models.find(model => model.id === input.modelId)
    if (!model || model.readiness !== 'ready' || !model.tasks.includes(input.task)) {
      throw new BridgeError('MODEL_NOT_READY', 'The backend has not declared this model and task ready.')
    }
    if (capabilities.executionKind === 'not_run') {
      throw new BridgeError('BACKEND_NOT_READY', 'The configured service has no active inference backend.')
    }
    const job = parseJob(await this.request('v1/jobs', signal, input), this.requireBase())
    if (job.modelId !== input.modelId || job.task !== input.task) {
      throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The submitted model and task do not match the returned job.')
    }
    if (job.executionKind !== 'not_run' && job.executionKind !== capabilities.executionKind) {
      throw new BridgeError('INVALID_BACKEND_RESPONSE', 'Job execution mode contradicts the backend capabilities.')
    }
    return job
  }

  async getJob(jobId: string, signal: AbortSignal): Promise<Job> {
    const job = parseJob(await this.request(`v1/jobs/${encodeURIComponent(identifier(jobId))}`, signal), this.requireBase())
    if (job.id !== jobId) throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The requested and returned job identifiers differ.')
    return job
  }

  private requireBase(): URL {
    if (!this.base) throw new BridgeError('BACKEND_NOT_CONFIGURED', 'NPU 服务尚未接入；请在插件配置中填写已验证服务的 backendURL。当前没有执行推理。')
    return this.base
  }

  private async request(path: string, signal: AbortSignal, body?: GenerateRequest): Promise<unknown> {
    signal.throwIfAborted()
    const url = new URL(path, this.requireBase())
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.config.apiToken.length === 0 ? {} : { Authorization: `Bearer ${this.config.apiToken}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (cause) {
      signal.throwIfAborted()
      if (timeout.aborted) throw new BridgeError('BACKEND_TIMEOUT', 'The NPU service did not respond before the configured timeout.')
      throw new BridgeError('BACKEND_UNREACHABLE', 'Could not reach the configured NPU service; no alternate backend was used.')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new BridgeError('BACKEND_HTTP_ERROR', `The NPU service returned HTTP ${response.status}.`)
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The NPU service must return application/json.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The NPU service returned an empty response.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > this.config.maxResponseBytes) {
          await reader.cancel()
          throw new BridgeError('RESPONSE_TOO_LARGE', 'The NPU service response exceeds the configured limit.')
        }
        chunks.push(chunk.value)
      }
    } catch (cause) {
      signal.throwIfAborted()
      if (timeout.aborted) throw new BridgeError('BACKEND_TIMEOUT', 'The NPU response body timed out.')
      if (cause instanceof BridgeError) throw cause
      throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The NPU response body was interrupted before it completed.')
    } finally {
      reader.releaseLock()
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch (cause) { throw new BridgeError('INVALID_BACKEND_RESPONSE', 'The NPU service returned malformed JSON.') }
  }
}
