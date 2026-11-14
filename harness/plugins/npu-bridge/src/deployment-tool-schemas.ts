import { DEPLOYMENT_PROTOCOL, TASK_SCHEMA_VERSION, DEPLOYMENT_MODEL, DEPLOYMENT_PROFILE, DEPLOYMENT_STATUSES, DEPLOYMENT_PHASES } from './deployment.js'

const text = { type: 'string', required: true } as const
const integer = { type: 'integer', required: true } as const
const boolean = { type: 'boolean', required: true } as const
const falseValue = { type: 'boolean', enum: [false], required: true } as const
const errorSchema = { type: 'object', additionalProperties: false, properties: { code: text, message: text } } as const

export const taskSpecSchema = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    schemaVersion: { type: 'string', enum: [TASK_SCHEMA_VERSION], required: true },
    intent: { type: 'string', enum: ['deploy-and-validate'], required: true },
    modelId: { type: 'string', enum: [DEPLOYMENT_MODEL], required: true },
    profileId: { type: 'string', enum: [DEPLOYMENT_PROFILE], required: true },
    parameters: { type: 'object', additionalProperties: false, required: true, properties: {
      prompt: text, seed: integer,
      width: { type: 'integer', enum: [256], required: true },
      height: { type: 'integer', enum: [256], required: true },
      batch: { type: 'integer', enum: [1], required: true },
      steps: { type: 'integer', enum: [4], required: true },
      guidanceScale: { type: 'number', enum: [1], required: true }, enableT5: falseValue,
    } },
    constraints: { type: 'object', additionalProperties: false, required: true, properties: {
      executionMode: { type: 'string', enum: ['hybrid'], required: true },
      requireFullNpu: falseValue, allowNpuComputeFallback: falseValue,
    } },
    acceptance: { type: 'object', additionalProperties: false, required: true, properties: {
      level: { type: 'string', enum: ['hybrid-smoke'], required: true },
    } },
  },
} as const

export const deploymentPlanSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    protocolVersion: { type: 'string', enum: [DEPLOYMENT_PROTOCOL], required: true },
    id: text, status: { type: 'string', enum: ['ready', 'blocked'], required: true },
    planDigest: text, spec: taskSpecSchema, expiresAt: text,
    steps: { type: 'array', items: { type: 'string' }, required: true },
    blockers: { type: 'array', items: errorSchema, required: true },
    scope: { type: 'object', additionalProperties: false, required: true, properties: {
      executionMode: { type: 'string', enum: ['hybrid'], required: true },
      npuModules: { type: 'array', items: { type: 'string' }, required: true },
      coreMigrationComplete: falseValue,
      validationLevel: { type: 'string', enum: ['hybrid-smoke'], required: true },
    } },
  },
} as const

export const deploymentJobSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    protocolVersion: { type: 'string', enum: [DEPLOYMENT_PROTOCOL], required: true },
    id: text, planId: text,
    profileId: { type: 'string', enum: [DEPLOYMENT_PROFILE], required: true },
    status: { type: 'string', enum: DEPLOYMENT_STATUSES, required: true },
    phase: { type: 'string', enum: DEPLOYMENT_PHASES, required: true },
    executionKind: { type: 'string', enum: ['not_run', 'simulation', 'hardware'], required: true },
    executionMode: { type: 'string', enum: ['hybrid'], required: true },
    coreMigrationComplete: falseValue,
    validationLevel: { type: 'string', enum: ['hybrid-smoke'], required: true },
    artifacts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: text, uri: text, mimeType: text,
    } } },
    createdAt: text, updatedAt: text, error: errorSchema,
    evidence: { type: 'object', additionalProperties: false, properties: {
      source: { type: 'string', enum: ['validated_adapter_report'], required: true },
      level: { type: 'string', enum: ['hybrid-smoke'], required: true },
      deviceExecution: { type: 'object', additionalProperties: false, required: true, properties: {
        status: { type: 'string', enum: ['passed', 'simulated'], required: true },
        npuCallCount: { type: 'integer', enum: [4], required: true },
        npuFallbackCount: { type: 'integer', enum: [0], required: true }, traceArtifactId: text,
      } },
      numericValidation: { type: 'object', additionalProperties: false, required: true, properties: {
        status: { type: 'string', enum: ['not_run', 'passed'], required: true }, metricsArtifactId: { type: 'string' },
      } },
      imageValidation: { type: 'object', additionalProperties: false, required: true, properties: {
        status: { type: 'string', enum: ['passed'], required: true }, artifactId: text,
        width: { type: 'integer', enum: [256], required: true }, height: { type: 'integer', enum: [256], required: true },
      } },
      evidenceIndexArtifactId: text,
    } },
  },
} as const

export const deploymentWaitSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    jobId: text, completed: boolean, timedOut: boolean, elapsedMs: integer,
    job: deploymentJobSchema, queryError: errorSchema,
  },
} as const
