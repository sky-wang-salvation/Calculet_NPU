import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { fields, record, text, uint32, digestValue, digest, fail, SCOPE, RECIPE_VERSION } from './contract.mjs';
import { relativePath, hashFile, noSymlinks, containedFile, parseJSON, readFileSafe } from './io.mjs';

function integer(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) fail('INVALID_CONFIG', `${label} must be an integer between ${min} and ${max}.`);
  return result;
}
function absolute(value, label) {
  text(value, label, 4096);
  if (!path.isAbsolute(value)) fail('INVALID_CONFIG', `${label} must be an absolute path.`);
  return path.normalize(value);
}
function timestamp(value, label) {
  text(value, label, 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_CONFIG', `${label} must be a UTC ISO-8601 timestamp.`);
  return new Date(value).toISOString();
}

export function normalizeConfig(raw = {}, baseDir = process.cwd()) {
  fields(raw, [], ['schemaVersion', 'listen', 'storageDir', 'apiTokenEnv', 'planTtlMs', 'maxRequestBytes', 'maxResultBytes', 'maxArtifactBytes', 'maxQueueDepth', 'queueWaitTimeoutMs', 'artifactUrlTtlMs', 'adapter', 'operatorAuthorization', 'resourceLockPath'], 'config');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 'calculet.deployment-config/v1') fail('INVALID_CONFIG', 'Unsupported configuration schema.');
  const listen = fields(raw.listen ?? {}, [], ['host', 'port'], 'listen');
  const host = listen.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) fail('INVALID_CONFIG', 'The service may bind only 127.0.0.1 or ::1.');
  const apiTokenEnv = raw.apiTokenEnv ?? 'CALCULET_DEPLOY_TOKEN';
  if (typeof apiTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiTokenEnv)) fail('INVALID_CONFIG', 'Invalid token environment variable name.');
  const storageDir = path.resolve(baseDir, text(raw.storageDir ?? '.local/deployment', 'storageDir', 4096));
  let adapter = null;
  if (raw.adapter != null) {
    const a = fields(raw.adapter, ['executionKind', 'executable', 'executableSha256', 'script', 'scriptSha256', 'cwd', 'modelRoot', 'components', 'timeoutMs'], ['args', 'environment', 'maxOutputBytes', 'inputPolicy'], 'adapter');
    if (!['hardware', 'simulation'].includes(a.executionKind)) fail('INVALID_CONFIG', 'adapter.executionKind must be hardware or simulation.');
    if (!Array.isArray(a.args ?? []) || (a.args ?? []).length > 32 || (a.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || ['--request', '--result'].includes(arg))) fail('INVALID_CONFIG', 'adapter.args must be bounded fixed arguments without protocol flags.');
    const environment = record(a.environment ?? {}, 'adapter.environment');
    if (Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32768 || key.toLowerCase() === apiTokenEnv.toLowerCase())) fail('INVALID_CONFIG', 'Adapter environment must contain fixed strings and must not contain the service token.');
    if (!Array.isArray(a.components) || a.components.length < 1 || a.components.length > 1024) fail('INVALID_CONFIG', 'An adapter requires a bounded, nonempty component manifest.');
    const components = a.components.map(row => {
      fields(row, ['path', 'sha256'], [], 'component');
      return { path: relativePath(row.path), sha256: digestValue(row.sha256) };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (new Set(components.map(row => row.path.toLowerCase())).size !== components.length) fail('INVALID_CONFIG', 'Component paths must be unique.');
    let inputPolicy;
    if (Object.hasOwn(a, 'inputPolicy')) {
      const policy = fields(a.inputPolicy, ['prompt', 'seed'], [], 'adapter.inputPolicy');
      inputPolicy = { prompt: text(policy.prompt, 'adapter.inputPolicy.prompt').trim(), seed: uint32(policy.seed) };
    }
    adapter = {
      executionKind: a.executionKind,
      executable: absolute(a.executable, 'executable'), executableSha256: digestValue(a.executableSha256),
      script: absolute(a.script, 'script'), scriptSha256: digestValue(a.scriptSha256),
      cwd: absolute(a.cwd, 'cwd'), modelRoot: absolute(a.modelRoot, 'modelRoot'), components,
      args: [...(a.args ?? [])], environment: { ...environment },
      timeoutMs: integer(a.timeoutMs, undefined, 10, 3600000, 'timeoutMs'),
      maxOutputBytes: integer(a.maxOutputBytes, 1048576, 1024, 16777216, 'maxOutputBytes'),
      ...(inputPolicy ? { inputPolicy } : {}),
    };
  }
  let operatorAuthorization = null;
  if (raw.operatorAuthorization != null) {
    const auth = fields(raw.operatorAuthorization, ['authorized', 'operatorId', 'authorizationId', 'resourceId', 'windowStart', 'windowEnd', 'sharedDeviceAcknowledged'], [], 'operatorAuthorization');
    if (typeof auth.authorized !== 'boolean' || typeof auth.sharedDeviceAcknowledged !== 'boolean') fail('INVALID_CONFIG', 'Authorization flags must be booleans.');
    operatorAuthorization = {
      authorized: auth.authorized, operatorId: text(auth.operatorId, 'operatorId', 128),
      authorizationId: text(auth.authorizationId, 'authorizationId', 128), resourceId: text(auth.resourceId, 'resourceId', 128),
      windowStart: timestamp(auth.windowStart, 'windowStart'), windowEnd: timestamp(auth.windowEnd, 'windowEnd'),
      sharedDeviceAcknowledged: auth.sharedDeviceAcknowledged,
    };
    if (Date.parse(operatorAuthorization.windowStart) >= Date.parse(operatorAuthorization.windowEnd)) fail('INVALID_CONFIG', 'Authorization window must have positive duration.');
  }
  const resourceLockPath = raw.resourceLockPath == null ? null : absolute(raw.resourceLockPath, 'resourceLockPath');
  if (resourceLockPath && (resourceLockPath === storageDir || path.dirname(resourceLockPath) === storageDir || resourceLockPath.startsWith(`${storageDir}${path.sep}`))) fail('INVALID_CONFIG', 'The shared device lock must be outside the private service storage.');
  return {
    listen: { host, port: integer(listen.port, 8766, 0, 65535, 'port') }, storageDir, apiTokenEnv,
    planTtlMs: integer(raw.planTtlMs, 300000, 1, 86400000, 'planTtlMs'),
    maxRequestBytes: integer(raw.maxRequestBytes, 65536, 1024, 1048576, 'maxRequestBytes'),
    maxResultBytes: integer(raw.maxResultBytes, 262144, 1024, 1048576, 'maxResultBytes'),
    maxArtifactBytes: integer(raw.maxArtifactBytes, 33554432, 1024, 268435456, 'maxArtifactBytes'),
    maxQueueDepth: integer(raw.maxQueueDepth, 32, 1, 1024, 'maxQueueDepth'),
    artifactUrlTtlMs: integer(raw.artifactUrlTtlMs, 300000, 1000, 900000, 'artifactUrlTtlMs'),
    queueWaitTimeoutMs: integer(raw.queueWaitTimeoutMs, 900000, 1, 86400000, 'queueWaitTimeoutMs'),
    adapter, operatorAuthorization, resourceLockPath,
  };
}

export async function loadConfig(file) {
  return normalizeConfig(parseJSON(await readFileSafe(file, 1048576), 'INVALID_CONFIG'), path.dirname(path.resolve(file)));
}

export function adapterEnvironment(config, env) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    if (/^(path|systemroot|windir|temp|tmp)$/i.test(key) && typeof value === 'string' && key.toLowerCase() !== config.apiTokenEnv.toLowerCase()) result[key] = value;
  }
  for (const [key, value] of Object.entries(config.adapter?.environment ?? {})) {
    for (const old of Object.keys(result)) if (old.toLowerCase() === key.toLowerCase()) delete result[old];
    result[key] = value;
  }
  return result;
}

export function inputPolicyBlocker(config, spec) {
  const policy = config.adapter?.inputPolicy;
  if (!policy || (spec?.parameters?.prompt === policy.prompt && spec?.parameters?.seed === policy.seed)) return null;
  return { code: 'ADAPTER_INPUT_NOT_SUPPORTED', message: 'This adapter accepts only its exact configured prompt and seed; no computation was started.' };
}

export function authorizationBlockers(config, now) {
  if (config.adapter?.executionKind !== 'hardware') return [];
  const auth = config.operatorAuthorization;
  if (!auth?.authorized || !auth.sharedDeviceAcknowledged) return [{ code: 'OPERATOR_AUTHORIZATION_REQUIRED', message: 'Explicit operator authorization and shared-device coordination acknowledgment are required.' }];
  if (now < Date.parse(auth.windowStart) || now >= Date.parse(auth.windowEnd)) return [{ code: 'AUTHORIZATION_WINDOW_CLOSED', message: 'The approved hardware window is not currently open.' }];
  if (now + config.adapter.timeoutMs > Date.parse(auth.windowEnd)) return [{ code: 'AUTHORIZATION_WINDOW_TOO_SHORT', message: 'The remaining hardware window does not cover the execution budget.' }];
  return [];
}

export async function inspectRuntime(config, env, clock = Date.now, { ownedDeviceToken = null } = {}) {
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  const a = config.adapter;
  if (!a) return { binding: null, blockers: [{ code: 'ADAPTER_NOT_CONFIGURED', message: 'Configure an approved local adapter and component manifest first.' }] };
  const binding = {
    recipeVersion: RECIPE_VERSION, scope: SCOPE, executionKind: a.executionKind,
    executable: a.executable, executableSha256: a.executableSha256, script: a.script, scriptSha256: a.scriptSha256,
    cwd: a.cwd, modelRoot: a.modelRoot, components: a.components, args: a.args,
    environmentDigest: digest(adapterEnvironment(config, env)), timeoutMs: a.timeoutMs, maxOutputBytes: a.maxOutputBytes,
    ...(a.inputPolicy ? { inputPolicy: a.inputPolicy } : {}),
    resourceLockPath: a.executionKind === 'hardware' ? config.resourceLockPath : null,
    operatorAuthorization: a.executionKind === 'hardware' ? config.operatorAuthorization : null,
  };
  try {
    if (await hashFile(a.executable) !== a.executableSha256) block('EXECUTABLE_DIGEST_MISMATCH', 'The configured executable identity changed.');
    if (await hashFile(a.script) !== a.scriptSha256) block('ADAPTER_DIGEST_MISMATCH', 'The configured adapter script identity changed.');
    for (const key of ['cwd', 'modelRoot']) {
      await noSymlinks(a[key]);
      if (!(await lstat(a[key])).isDirectory()) fail('UNSAFE_PATH', 'Adapter working and model paths must be directories.');
      binding[key] = await realpath(a[key]);
    }
    for (const component of a.components) {
      const file = await containedFile(binding.modelRoot, component.path);
      if (await hashFile(file) !== component.sha256) block('COMPONENT_DIGEST_MISMATCH', 'An approved component identity changed.');
    }
  } catch { block('RUNTIME_FILES_UNAVAILABLE', 'Approved runtime files are missing, unsafe, inaccessible, or changed during inspection.'); }
  if (a.executionKind === 'hardware') {
    blockers.push(...authorizationBlockers(config, clock()));
    if (!config.resourceLockPath) block('RESOURCE_LOCK_REQUIRED', 'Configure the shared cooperative device lock before hardware use.');
    else {
      try {
        await noSymlinks(path.dirname(config.resourceLockPath));
        try {
          const existing = parseJSON(await readFileSafe(config.resourceLockPath, 8192), 'LOCK_INVALID');
          if (!ownedDeviceToken || existing.token !== ownedDeviceToken) block('RESOURCE_BUSY', 'A cooperative device lock already exists; operator reconciliation is required.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } catch { block('RESOURCE_LOCK_UNAVAILABLE', 'The cooperative lock location is unavailable or unsafe.'); }
    }
  } else if (config.operatorAuthorization?.authorized) {
    block('MODE_CONFIGURATION_MISMATCH', 'A simulation adapter must not carry an active hardware authorization.');
  }
  return { binding, blockers };
}
