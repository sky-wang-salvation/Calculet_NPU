import { createHash, randomUUID } from 'node:crypto';

export const TASK_VERSION = 'calculet.task/v1';
export const DEPLOY_VERSION = 'calculet.deploy/v1';
export const GENERATION_VERSION = 'calculet.npu/v1';
export const PROFILE_ID = 'sd35-qproj-hybrid-smoke-v1';
export const RECIPE_VERSION = `${PROFILE_ID}.0`;
export const DEFAULT_SEED = 20261115;
export const NPU_MODULES = Object.freeze(['transformer_blocks[0].attn.to_q']);
export const CPU_MODULES = Object.freeze(['text_encoders', 'transformer_except_npu_modules', 'scheduler', 'vae_decoder']);
export const SCOPE = Object.freeze({
  executionMode: 'hybrid', npuModules: NPU_MODULES, cpuModules: CPU_MODULES,
  coreMigrationComplete: false, validationLevel: 'hybrid-smoke',
});
export const STEPS = Object.freeze(['preflight', 'prepare', 'run_validation', 'collect_evidence', 'register_capability']);
export const SHA256 = /^[a-f0-9]{64}$/;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class DeploymentError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.status = status;
  }
}

export function fail(code, message, status = 400) {
  throw new DeploymentError(code, message, status);
}

export function record(value, label = 'object') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_REQUEST', `${label} must be a JSON object.`);
  }
  return value;
}

export function fields(value, required, optional = [], label = 'object') {
  record(value, label);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('INVALID_REQUEST', `${label} contains an unsupported field.`);
  if (required.some(key => !Object.hasOwn(value, key))) fail('INVALID_REQUEST', `${label} is missing a required field.`);
  return value;
}

export function text(value, label, max = 8000) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim().length === 0 || value.includes('\0')) {
    fail('INVALID_REQUEST', `${label} must be nonempty text of at most ${max} characters without NUL.`);
  }
  return value;
}

export function uint32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail('INVALID_REQUEST', 'seed must be an unsigned 32-bit integer.');
  return value;
}

export function exact(value, expected, label) {
  if (value !== expected) fail('UNSUPPORTED_RECIPE', `${label} must equal ${JSON.stringify(expected)}.`);
  return value;
}

export function identifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('INVALID_REQUEST', `Invalid ${label}.`);
  return value;
}

export function digestValue(value, label = 'digest') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('INVALID_REQUEST', `${label} must be lowercase SHA-256.`);
  return value;
}

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('Only finite JSON values can be canonicalized.');
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
export const digest = value => sha256(canonicalJSON(value));
export const newId = prefix => `${prefix}-${randomUUID()}`;

export function normalizeTaskSpec(value) {
  fields(value, ['schemaVersion', 'intent', 'modelId', 'profileId', 'parameters', 'constraints', 'acceptance'], [], 'spec');
  const p = fields(value.parameters, ['prompt', 'seed', 'width', 'height', 'batch', 'steps', 'guidanceScale', 'enableT5'], [], 'parameters');
  const c = fields(value.constraints, ['executionMode', 'requireFullNpu', 'allowNpuComputeFallback'], [], 'constraints');
  const a = fields(value.acceptance, ['level'], [], 'acceptance');
  return {
    schemaVersion: exact(value.schemaVersion, TASK_VERSION, 'schemaVersion'),
    intent: exact(value.intent, 'deploy-and-validate', 'intent'),
    modelId: exact(value.modelId, 'sd35-medium', 'modelId'),
    profileId: exact(value.profileId, PROFILE_ID, 'profileId'),
    parameters: {
      prompt: text(p.prompt, 'prompt').trim(), seed: uint32(p.seed),
      width: exact(p.width, 256, 'width'), height: exact(p.height, 256, 'height'),
      batch: exact(p.batch, 1, 'batch'), steps: exact(p.steps, 4, 'steps'),
      guidanceScale: exact(p.guidanceScale, 1, 'guidanceScale'), enableT5: exact(p.enableT5, false, 'enableT5'),
    },
    constraints: {
      executionMode: exact(c.executionMode, 'hybrid', 'executionMode'),
      requireFullNpu: exact(c.requireFullNpu, false, 'requireFullNpu'),
      allowNpuComputeFallback: exact(c.allowNpuComputeFallback, false, 'allowNpuComputeFallback'),
    },
    acceptance: { level: exact(a.level, 'hybrid-smoke', 'acceptance.level') },
  };
}

export function specForGeneration(value) {
  fields(value, ['modelId', 'task', 'prompt'], ['seed'], 'generation request');
  exact(value.modelId, PROFILE_ID, 'modelId');
  exact(value.task, 'text-to-image', 'task');
  return normalizeTaskSpec({
    schemaVersion: TASK_VERSION, intent: 'deploy-and-validate', modelId: 'sd35-medium', profileId: PROFILE_ID,
    parameters: { prompt: value.prompt, seed: value.seed === undefined ? DEFAULT_SEED : value.seed, width: 256, height: 256, batch: 1, steps: 4, guidanceScale: 1, enableT5: false },
    constraints: { executionMode: 'hybrid', requireFullNpu: false, allowNpuComputeFallback: false },
    acceptance: { level: 'hybrid-smoke' },
  });
}

export function buildPlan(input, binding, blockers = [], { now = Date.now(), ttlMs = 300000, id = newId('plan') } = {}) {
  const spec = normalizeTaskSpec(input);
  const planDigest = digest({ recipeVersion: RECIPE_VERSION, spec, binding });
  return {
    protocolVersion: DEPLOY_VERSION, id, status: blockers.length ? 'blocked' : 'ready', planDigest,
    spec, steps: [...STEPS], blockers: structuredClone(blockers), expiresAt: new Date(now + ttlMs).toISOString(),
    scope: structuredClone(SCOPE),
  };
}

export function applyRequest(value) {
  fields(value, ['planId', 'planDigest', 'idempotencyKey'], [], 'apply request');
  identifier(value.planId, 'planId');
  digestValue(value.planDigest, 'planDigest');
  idempotencyKey(value.idempotencyKey);
  return { planId: value.planId, planDigest: value.planDigest, idempotencyKey: value.idempotencyKey };
}

export function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('INVALID_REQUEST', 'idempotencyKey must be 1–128 portable ASCII characters.');
  return value;
}
