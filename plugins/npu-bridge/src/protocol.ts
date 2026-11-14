/** Validated messages exchanged with the future NPU host service. */
export const PROTOCOL_VERSION = 'calculet.npu/v1'

export const TASKS = ['text-to-image', 'text-to-video', 'image-to-video'] as const
export type Task = typeof TASKS[number]
export type ExecutionKind = 'hardware' | 'simulation' | 'not_run'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ModelInfo {
  id: string
  displayName: string
  tasks: Task[]
  readiness: 'ready' | 'testing' | 'unavailable'
}

export interface Capabilities {
  protocolVersion: typeof PROTOCOL_VERSION
  backendId: string
  executionKind: ExecutionKind
  models: ModelInfo[]
}

export interface Artifact {
  id: string
  uri: string
  mimeType: string
}

export interface Job {
  id: string
  status: JobStatus
  modelId: string
  task: Task
  executionKind: ExecutionKind
  artifacts: Artifact[]
  error?: { code: string; message: string }
}

export interface GenerateRequest {
  modelId: string
  task: Task
  prompt: string
  seed?: number
  inputArtifactId?: string
}

/** A stable failure code that the Harness adapter projects as a tool error. */
export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('INVALID_BACKEND_RESPONSE', 'Expected a JSON object from the NPU backend.')
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError('INVALID_BACKEND_RESPONSE', `Missing or invalid ${field}.`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T {
  const result = string(value, field)
  const selected = values.find(item => item === result)
  if (selected === undefined) throw new BridgeError('INVALID_BACKEND_RESPONSE', `Unsupported ${field}.`)
  return selected
}

/** Validate an opaque backend identifier before using it in a request path. */
export function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new BridgeError('INVALID_IDENTIFIER', 'Use a backend-issued job or artifact identifier.')
  }
  return value
}

/** Parse capabilities without treating a project status note as a ready model. */
export function parseCapabilities(value: unknown): Capabilities {
  const row = object(value)
  if (row.protocolVersion !== PROTOCOL_VERSION) {
    throw new BridgeError('UNSUPPORTED_PROTOCOL', `The NPU backend must use ${PROTOCOL_VERSION}.`)
  }
  if (!Array.isArray(row.models)) throw new BridgeError('INVALID_BACKEND_RESPONSE', 'models must be an array.')
  const ids = new Set<string>()
  const models = row.models.map(value => {
    const model = object(value)
    const id = string(model.id, 'model.id')
    if (ids.has(id)) throw new BridgeError('INVALID_BACKEND_RESPONSE', 'Duplicate model identifier.')
    ids.add(id)
    if (!Array.isArray(model.tasks) || model.tasks.length === 0) {
      throw new BridgeError('INVALID_BACKEND_RESPONSE', 'A model must declare its supported tasks.')
    }
    return {
      id,
      displayName: string(model.displayName, 'model.displayName'),
      tasks: model.tasks.map(task => oneOf(task, TASKS, 'task')),
      readiness: oneOf(model.readiness, ['ready', 'testing', 'unavailable'] as const, 'readiness'),
    }
  })
  return {
    protocolVersion: PROTOCOL_VERSION,
    backendId: string(row.backendId, 'backendId'),
    executionKind: oneOf(row.executionKind, ['hardware', 'simulation', 'not_run'] as const, 'executionKind'),
    models,
  }
}

/** Parse job results and require real artifact references for successful work. */
export function parseJob(value: unknown, backendURL: URL): Job {
  const row = object(value)
  const status = oneOf(row.status, ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const, 'status')
  const executionKind = oneOf(row.executionKind, ['hardware', 'simulation', 'not_run'] as const, 'executionKind')
  if (!Array.isArray(row.artifacts)) throw new BridgeError('INVALID_BACKEND_RESPONSE', 'artifacts must be an array.')
  const artifacts = row.artifacts.map(value => {
    const item = object(value)
    let uri: URL
    try { uri = new URL(string(item.uri, 'artifact.uri'), backendURL) }
    catch { throw new BridgeError('INVALID_BACKEND_RESPONSE', 'Invalid artifact URL.') }
    if (uri.origin !== backendURL.origin || uri.username || uri.password) {
      throw new BridgeError('INVALID_BACKEND_RESPONSE', 'Artifact URLs must belong to the configured NPU service.')
    }
    return {
      id: identifier(string(item.id, 'artifact.id')),
      uri: uri.href,
      mimeType: string(item.mimeType, 'artifact.mimeType'),
    }
  })
  if (status === 'succeeded' && (artifacts.length === 0 || executionKind === 'not_run')) {
    throw new BridgeError('INVALID_BACKEND_RESPONSE', 'A successful generation must include artifacts and an execution mode.')
  }
  let error: Job['error']
  if (row.error !== undefined) {
    const detail = object(row.error)
    error = { code: string(detail.code, 'error.code'), message: string(detail.message, 'error.message') }
  }
  if (status === 'failed' && error === undefined) {
    throw new BridgeError('INVALID_BACKEND_RESPONSE', 'A failed job must explain the failure.')
  }
  return {
    id: identifier(string(row.id, 'job.id')),
    status, executionKind,
    modelId: string(row.modelId, 'modelId'),
    task: oneOf(row.task, TASKS, 'task'),
    artifacts,
    ...(error === undefined ? {} : { error }),
  }
}
