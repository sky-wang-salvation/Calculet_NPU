import { BridgeError, identifier } from './protocol.js'
import type { Artifact, ExecutionKind } from './protocol.js'

export const DEPLOYMENT_PROTOCOL = 'calculet.deploy/v1'
export const TASK_SCHEMA_VERSION = 'calculet.task/v1'
export const DEPLOYMENT_MODEL = 'sd35-medium'
export const DEPLOYMENT_PROFILE = 'sd35-qproj-hybrid-smoke-v1'
export const NPU_MODULE = 'transformer_blocks[0].attn.to_q'
export const DEPLOYMENT_STEPS = ['preflight', 'prepare', 'run_validation', 'collect_evidence', 'register_capability'] as const
export const DEPLOYMENT_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'reconciling'] as const
export const DEPLOYMENT_PHASES = ['queued', ...DEPLOYMENT_STEPS, 'complete', 'failed', 'blocked', 'reconciling'] as const
export type DeploymentStatus = typeof DEPLOYMENT_STATUSES[number]

export interface DeploymentInput {
  prompt: string
  modelId?: string
  profileId?: string
  seed?: number
  width?: number
  height?: number
  batch?: number
  steps?: number
  guidanceScale?: number
  enableT5?: boolean
  requireFullNpu?: boolean
  allowNpuComputeFallback?: boolean
}

export interface TaskSpec {
  schemaVersion: typeof TASK_SCHEMA_VERSION
  intent: 'deploy-and-validate'
  modelId: typeof DEPLOYMENT_MODEL
  profileId: typeof DEPLOYMENT_PROFILE
  parameters: {
    prompt: string
    seed: number
    width: 256
    height: 256
    batch: 1
    steps: 4
    guidanceScale: 1
    enableT5: false
  }
  constraints: {
    executionMode: 'hybrid'
    requireFullNpu: false
    allowNpuComputeFallback: false
  }
  acceptance: { level: 'hybrid-smoke' }
}

export interface DeploymentPlan {
  protocolVersion: typeof DEPLOYMENT_PROTOCOL
  id: string
  status: 'ready' | 'blocked'
  planDigest: string
  spec: TaskSpec
  steps: string[]
  blockers: { code: string; message: string }[]
  expiresAt: string
  scope: {
    executionMode: 'hybrid'
    npuModules: string[]
    coreMigrationComplete: false
    validationLevel: 'hybrid-smoke'
  }
}

export interface DeploymentEvidence {
  source: 'validated_adapter_report'
  level: 'hybrid-smoke'
  deviceExecution: {
    status: 'passed' | 'simulated'
    npuCallCount: 4
    npuFallbackCount: 0
    traceArtifactId: string
  }
  numericValidation: { status: 'not_run' | 'passed'; metricsArtifactId?: string }
  imageValidation: { status: 'passed'; artifactId: string; width: 256; height: 256 }
  evidenceIndexArtifactId: string
}

export interface DeploymentJob {
  protocolVersion: typeof DEPLOYMENT_PROTOCOL
  id: string
  planId: string
  profileId: typeof DEPLOYMENT_PROFILE
  status: DeploymentStatus
  phase: typeof DEPLOYMENT_PHASES[number]
  executionKind: ExecutionKind
  executionMode: 'hybrid'
  coreMigrationComplete: false
  validationLevel: 'hybrid-smoke'
  artifacts: Artifact[]
  createdAt: string
  updatedAt: string
  error?: { code: string; message: string }
  evidence?: DeploymentEvidence
}

export interface ApplyDeploymentInput {
  planId: string
  planDigest: string
  idempotencyKey: string
}

const fail = (message: string, code = 'INVALID_BACKEND_RESPONSE'): never => { throw new BridgeError(code, message) }
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`)
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty text.`)
  return value as string
}
const enumValue = <T extends string>(value: unknown, choices: readonly T[], label: string): T => {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(`Unsupported ${label}.`)
  return value as T
}
const keys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  if (Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !(key in value))) {
    fail(`Unexpected or missing ${label} fields.`)
  }
}
const time = (value: unknown, label: string): string => {
  const result = text(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) {
    fail(`Invalid ${label}.`)
  }
  return result
}
export const deploymentDigest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('Use the SHA-256 plan digest returned by the service.', 'INVALID_REQUEST')
  return value as string
}

export function makeDeploymentSpec(input: DeploymentInput, maxPromptChars = 8000): TaskSpec {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('Provide deployment parameters.', 'INVALID_REQUEST')
  const allowed = ['prompt', 'modelId', 'profileId', 'seed', 'width', 'height', 'batch', 'steps', 'guidanceScale', 'enableT5', 'requireFullNpu', 'allowNpuComputeFallback']
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('Unknown deployment parameter; no field was silently ignored.', 'INVALID_REQUEST')
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > Math.min(maxPromptChars, 8000)) {
    fail('Provide a nonempty prompt within the configured limit.', 'INVALID_REQUEST')
  }
  if ((input.modelId !== undefined && input.modelId !== DEPLOYMENT_MODEL)
    || (input.profileId !== undefined && input.profileId !== DEPLOYMENT_PROFILE)) {
    fail('Only the registered SD3.5 HYBRID smoke profile is supported.', 'UNSUPPORTED_DEPLOYMENT_PROFILE')
  }
  const fixed = { width: 256, height: 256, batch: 1, steps: 4, guidanceScale: 1, enableT5: false, requireFullNpu: false, allowNpuComputeFallback: false } as const
  for (const key of Object.keys(fixed) as (keyof typeof fixed)[]) {
    if (input[key] !== undefined && input[key] !== fixed[key]) {
      fail(`The approved profile does not support ${key}=${String(input[key])}; the request was not downgraded.`, 'UNSUPPORTED_DEPLOYMENT_PROFILE')
    }
  }
  const seed = input.seed === undefined ? 20261115 : input.seed
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) fail('seed must be an unsigned 32-bit integer.', 'INVALID_REQUEST')
  return {
    schemaVersion: TASK_SCHEMA_VERSION, intent: 'deploy-and-validate', modelId: DEPLOYMENT_MODEL, profileId: DEPLOYMENT_PROFILE,
    parameters: { prompt: input.prompt.trim(), seed, width: 256, height: 256, batch: 1, steps: 4, guidanceScale: 1, enableT5: false },
    constraints: { executionMode: 'hybrid', requireFullNpu: false, allowNpuComputeFallback: false },
    acceptance: { level: 'hybrid-smoke' },
  }
}

export function parseTaskSpec(value: unknown): TaskSpec {
  const spec = record(value, 'spec')
  keys(spec, ['schemaVersion', 'intent', 'modelId', 'profileId', 'parameters', 'constraints', 'acceptance'], 'spec')
  if (spec.schemaVersion !== TASK_SCHEMA_VERSION || spec.intent !== 'deploy-and-validate') fail('Unsupported task schema or intent.')
  const parameters = record(spec.parameters, 'parameters')
  keys(parameters, ['prompt', 'seed', 'width', 'height', 'batch', 'steps', 'guidanceScale', 'enableT5'], 'parameters')
  const constraints = record(spec.constraints, 'constraints')
  keys(constraints, ['executionMode', 'requireFullNpu', 'allowNpuComputeFallback'], 'constraints')
  const acceptance = record(spec.acceptance, 'acceptance')
  keys(acceptance, ['level'], 'acceptance')
  if (constraints.executionMode !== 'hybrid' || acceptance.level !== 'hybrid-smoke') fail('Unexpected deployment scope.')
  try {
    return makeDeploymentSpec({ modelId: spec.modelId, profileId: spec.profileId, ...parameters,
      requireFullNpu: constraints.requireFullNpu, allowNpuComputeFallback: constraints.allowNpuComputeFallback } as unknown as DeploymentInput)
  } catch { return fail('Invalid parameters in the returned task specification.') }
}

export function parseDeploymentPlan(value: unknown): DeploymentPlan {
  const row = record(value, 'deployment plan')
  if (row.protocolVersion !== DEPLOYMENT_PROTOCOL) fail('Unsupported deployment protocol.', 'UNSUPPORTED_PROTOCOL')
  const status = enumValue(row.status, ['ready', 'blocked'] as const, 'plan status')
  const spec = parseTaskSpec(row.spec)
  let digest: string
  try { digest = deploymentDigest(row.planDigest) } catch { return fail('Invalid returned plan digest.') }
  if (!Array.isArray(row.steps) || row.steps.length !== DEPLOYMENT_STEPS.length
    || row.steps.some((step, index) => step !== DEPLOYMENT_STEPS[index])) fail('Unexpected deployment steps.')
  if (!Array.isArray(row.blockers)) fail('Plan blockers must be an array.')
  const blockers = (row.blockers as unknown[]).map(value => {
    const blocker = record(value, 'blocker')
    return { code: text(blocker.code, 'blocker.code'), message: text(blocker.message, 'blocker.message') }
  })
  if ((status === 'ready' && blockers.length > 0) || (status === 'blocked' && blockers.length === 0)) fail('Plan readiness contradicts blockers.')
  const scope = record(row.scope, 'scope')
  if (scope.executionMode !== 'hybrid' || scope.coreMigrationComplete !== false || scope.validationLevel !== 'hybrid-smoke'
    || !Array.isArray(scope.npuModules) || scope.npuModules.length !== 1 || scope.npuModules[0] !== NPU_MODULE) fail('The plan changed the supported execution scope.')
  return {
    protocolVersion: DEPLOYMENT_PROTOCOL, id: identifier(text(row.id, 'plan.id')), status, planDigest: digest, spec,
    steps: [...DEPLOYMENT_STEPS], blockers, expiresAt: time(row.expiresAt, 'expiresAt'),
    scope: { executionMode: 'hybrid', npuModules: [NPU_MODULE], coreMigrationComplete: false, validationLevel: 'hybrid-smoke' },
  }
}

export function parseDeploymentJob(value: unknown, backendURL: URL): DeploymentJob {
  const row = record(value, 'deployment job')
  if (row.protocolVersion !== DEPLOYMENT_PROTOCOL) fail('Unsupported deployment protocol.', 'UNSUPPORTED_PROTOCOL')
  if (row.profileId !== DEPLOYMENT_PROFILE || row.executionMode !== 'hybrid'
    || row.coreMigrationComplete !== false || row.validationLevel !== 'hybrid-smoke') fail('Unexpected deployment profile or validation level.')
  const status = enumValue(row.status, DEPLOYMENT_STATUSES, 'deployment status')
  const phase = enumValue(row.phase, DEPLOYMENT_PHASES, 'deployment phase')
  const executionKind = enumValue(row.executionKind, ['not_run', 'simulation', 'hardware'] as const, 'execution kind')
  if (!Array.isArray(row.artifacts)) fail('Deployment artifacts must be an array.')
  const ids = new Set<string>()
  const artifacts = (row.artifacts as unknown[]).map(value => {
    const artifact = record(value, 'artifact')
    const id = identifier(text(artifact.id, 'artifact.id'))
    if (ids.has(id)) fail('Duplicate deployment artifact ID.')
    ids.add(id)
    let uri: URL
    try { uri = new URL(text(artifact.uri, 'artifact.uri'), backendURL) } catch { return fail('Invalid artifact URL.') }
    if (uri.origin !== backendURL.origin || uri.username || uri.password) fail('Deployment artifacts must belong to the configured service.')
    return { id, uri: uri.href, mimeType: text(artifact.mimeType, 'artifact.mimeType') }
  })
  let error: DeploymentJob['error']
  if (row.error !== undefined) {
    const detail = record(row.error, 'error')
    error = { code: text(detail.code, 'error.code'), message: text(detail.message, 'error.message') }
  }
  if (['failed', 'blocked', 'reconciling'].includes(status) && !error) fail('An unsuccessful deployment must explain its state.')
  let evidence: DeploymentEvidence | undefined
  if (row.evidence !== undefined) {
    const detail = record(row.evidence, 'evidence')
    keys(detail, ['source', 'level', 'deviceExecution', 'numericValidation', 'imageValidation', 'evidenceIndexArtifactId'], 'evidence')
    if (detail.source !== 'validated_adapter_report' || detail.level !== 'hybrid-smoke') fail('Unexpected evidence source or level.')
    const device = record(detail.deviceExecution, 'deviceExecution')
    keys(device, ['status', 'npuCallCount', 'npuFallbackCount', 'traceArtifactId'], 'deviceExecution')
    const deviceStatus = enumValue(device.status, ['passed', 'simulated'] as const, 'device evidence status')
    if (executionKind === 'not_run' || (executionKind === 'simulation' ? deviceStatus !== 'simulated' : deviceStatus !== 'passed')
      || device.npuCallCount !== 4 || device.npuFallbackCount !== 0) fail('Device evidence contradicts the execution mode or fixed profile.')
    const numeric = record(detail.numericValidation, 'numericValidation')
    const numericStatus = enumValue(numeric.status, ['not_run', 'passed'] as const, 'numeric validation status')
    const image = record(detail.imageValidation, 'imageValidation')
    keys(image, ['status', 'artifactId', 'width', 'height'], 'imageValidation')
    if (image.status !== 'passed' || image.width !== 256 || image.height !== 256) fail('Image evidence contradicts the fixed profile.')
    const reference = (value: unknown, label: string, mimeTypes: string[]): string => {
      const id = identifier(text(value, label))
      if (!artifacts.some(artifact => artifact.id === id && mimeTypes.includes(artifact.mimeType))) fail(`Missing artifact referenced by ${label}.`)
      return id
    }
    const traceArtifactId = reference(device.traceArtifactId, 'traceArtifactId', ['application/json', 'text/plain'])
    const artifactId = reference(image.artifactId, 'image artifactId', ['image/png'])
    const evidenceIndexArtifactId = reference(detail.evidenceIndexArtifactId, 'evidenceIndexArtifactId', ['application/json'])
    let metricsArtifactId: string | undefined
    if (numericStatus === 'passed') {
      keys(numeric, ['status', 'metricsArtifactId'], 'numericValidation')
      metricsArtifactId = reference(numeric.metricsArtifactId, 'metricsArtifactId', ['application/json'])
    } else keys(numeric, ['status'], 'numericValidation')
    evidence = {
      source: 'validated_adapter_report', level: 'hybrid-smoke',
      deviceExecution: { status: deviceStatus, npuCallCount: 4, npuFallbackCount: 0, traceArtifactId },
      numericValidation: { status: numericStatus, ...(metricsArtifactId ? { metricsArtifactId } : {}) },
      imageValidation: { status: 'passed', artifactId, width: 256, height: 256 }, evidenceIndexArtifactId,
    }
  }
  if (status === 'succeeded' && (phase !== 'complete' || executionKind === 'not_run' || error || !evidence
    || !artifacts.some(artifact => artifact.mimeType === 'image/png')
    || !artifacts.some(artifact => artifact.mimeType === 'application/json'))) fail('Successful deployment requires an execution mode, validation output and evidence index.')
  return {
    protocolVersion: DEPLOYMENT_PROTOCOL, id: identifier(text(row.id, 'job.id')), planId: identifier(text(row.planId, 'planId')),
    profileId: DEPLOYMENT_PROFILE, status, phase, executionKind, executionMode: 'hybrid', coreMigrationComplete: false,
    validationLevel: 'hybrid-smoke', artifacts, createdAt: time(row.createdAt, 'createdAt'), updatedAt: time(row.updatedAt, 'updatedAt'),
    ...(error ? { error } : {}), ...(evidence ? { evidence } : {}),
  }
}
