import path from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import {
  fields, exact, identifier, digestValue, canonicalJSON, sha256, digest, fail,
  DeploymentError, newId, RECIPE_VERSION, PROFILE_ID, SCOPE, NPU_MODULES, CPU_MODULES,
} from './contract.mjs';
import { atomicJSON, containedFile, readFileSafe, parseJSON, relativePath } from './io.mjs';
import { adapterEnvironment, authorizationBlockers, inputPolicyBlocker } from './config.mjs';

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validatePNG(data, width = 256, height = 256) {
  const invalid = () => fail('INVALID_PNG', 'The image must be a complete non-interlaced 8-bit RGB/RGBA PNG of the approved dimensions.');
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8;
  let channels;
  let ended = false;
  let idatEnded = false;
  let seenIdat = false;
  const compressed = [];
  while (offset < data.length) {
    if (offset + 12 > data.length) invalid();
    const length = data.readUInt32BE(offset);
    if (offset + 12 + length > data.length) invalid();
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (data.readUInt32BE(offset + 8 + length) !== crc32(data.subarray(offset + 4, offset + 8 + length))) invalid();
    if (offset === 8 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13 || chunk.readUInt32BE(0) !== width || chunk.readUInt32BE(4) !== height
        || chunk[8] !== 8 || ![2, 6].includes(chunk[9]) || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) invalid();
      channels = chunk[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (idatEnded) invalid();
      seenIdat = true;
      compressed.push(chunk);
    } else {
      if (seenIdat) idatEnded = true;
      if (type === 'IEND') {
        if (length !== 0 || !seenIdat || offset + 12 !== data.length) invalid();
        ended = true;
      } else if (/^[A-Z]/.test(type) && type !== 'PLTE') invalid();
      else if (type === 'PLTE' && (seenIdat || length === 0 || length > 768 || length % 3 !== 0)) invalid();
    }
    offset += 12 + length;
  }
  if (!ended || !channels) invalid();
  const rowBytes = 1 + width * channels;
  let decoded;
  try { decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowBytes * height }); }
  catch { invalid(); }
  if (decoded.length !== rowBytes * height) invalid();
  for (let row = 0; row < height; row++) if (decoded[row * rowBytes] > 4) invalid();
}

export function makeAdapterRequest(job, config, jobDir, now) {
  const controllerLockPath = config.adapter.executionKind === 'hardware' ? config.resourceLockPath : null;
  if (config.adapter.executionKind === 'hardware' && (typeof controllerLockPath !== 'string' || !path.isAbsolute(controllerLockPath))) {
    fail('RESOURCE_LOCK_REQUIRED', 'A hardware request requires the approved absolute controller lock path.');
  }
  const request = {
    schemaVersion: 'calculet.adapter-request/v1', requestId: newId('request'), jobId: job.id, jobKind: job.kind,
    planId: job.planId, planDigest: job.planDigest, recipeVersion: RECIPE_VERSION, profileId: PROFILE_ID,
    executionKind: config.adapter.executionKind, spec: job.spec, scope: structuredClone(SCOPE),
    paths: { jobDir, artifactsDir: path.join(jobDir, 'artifacts'), modelRoot: job.binding.modelRoot, components: config.adapter.components, controllerLockPath },
    limits: { timeoutMs: config.adapter.timeoutMs, deadlineAt: new Date(now + config.adapter.timeoutMs).toISOString() },
    authorization: config.adapter.executionKind === 'hardware' ? config.operatorAuthorization : null,
  };
  return { ...request, requestDigest: digest(request) };
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
}

export async function runAdapter(config, env, jobDir, request, signal, { clock = Date.now, onLaunch = () => {} } = {}) {
  const requestPath = path.join(jobDir, 'request.json');
  const resultPath = path.join(jobDir, 'result.json');
  await atomicJSON(requestPath, request);
  if (signal.aborted) fail('SERVICE_SHUTDOWN', 'The service stopped before adapter launch.');
  const stdout = openSync(path.join(jobDir, 'stdout.log'), 'wx', 0o600);
  let stderr;
  try {
    stderr = openSync(path.join(jobDir, 'stderr.log'), 'wx', 0o600);
    await new Promise((resolve, reject) => {
      const a = config.adapter;
      let child;
      let timeout;
      let killTimeout;
      let reason;
      let finished = false;
      let outputBytes = 0;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const terminate = (code, message) => {
        if (reason || finished) return;
        reason = new DeploymentError(code, message);
        killTree(child);
        killTimeout = setTimeout(() => finish(new DeploymentError('ADAPTER_TERMINATION_UNCONFIRMED', 'Adapter termination could not be confirmed; operator reconciliation is required.')), 5000);
      };
      const abort = () => terminate('SERVICE_SHUTDOWN', 'The service stopped during adapter execution; execution will not be retried.');
      let budget;
      try {
        const checkedAt = clock();
        const blocker = inputPolicyBlocker(config, request.spec) ?? authorizationBlockers(config, checkedAt)[0];
        if (blocker) fail(blocker.code, blocker.message);
        budget = Math.min(a.timeoutMs, Date.parse(request.limits.deadlineAt) - checkedAt);
        if (budget <= 0) fail('REQUEST_DEADLINE_EXPIRED', 'The execution deadline expired before the adapter could start.');
        child = spawn(a.executable, [a.script, ...a.args, '--request', requestPath, '--result', resultPath], {
          cwd: a.cwd, env: adapterEnvironment(config, env), shell: false, windowsHide: true,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.once('spawn', onLaunch);
      } catch (error) {
        finish(error instanceof DeploymentError ? error : new DeploymentError('ADAPTER_START_FAILED', 'The configured adapter could not be started.'));
        return;
      }
      const output = fd => chunk => {
        if (finished) return;
        outputBytes += chunk.length;
        if (outputBytes > a.maxOutputBytes) { terminate('ADAPTER_OUTPUT_LIMIT', 'Adapter output exceeded its configured limit.'); return; }
        try { writeSync(fd, chunk); }
        catch { terminate('ADAPTER_LOG_WRITE_FAILED', 'Adapter logs could not be persisted.'); }
      };
      child.stdout.on('data', output(stdout));
      child.stderr.on('data', output(stderr));
      child.once('error', () => finish(new DeploymentError('ADAPTER_START_FAILED', 'The configured adapter could not be started.')));
      child.once('close', (code, exitSignal) => {
        if (reason) finish(reason);
        else if (code !== 0 || exitSignal !== null) finish(new DeploymentError('ADAPTER_EXIT_NONZERO', 'The adapter did not exit successfully.'));
        else finish();
      });
      signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => terminate('ADAPTER_TIMEOUT', 'The adapter exceeded its execution budget; no automatic retry will occur.'), budget);
      if (signal.aborted) abort();
    });
  } finally { closeSync(stdout); if (stderr !== undefined) closeSync(stderr); }
  const reread = parseJSON(await readFileSafe(requestPath, 1048576), 'REQUEST_CHANGED');
  if (canonicalJSON(reread) !== canonicalJSON(request)) fail('REQUEST_CHANGED', 'The adapter modified its immutable request.');
  let result;
  try { result = parseJSON(await readFileSafe(resultPath, config.maxResultBytes), 'ADAPTER_PROTOCOL_ERROR'); }
  catch (error) {
    if (error.code === 'ENOENT') fail('ADAPTER_RESULT_MISSING', 'The adapter exited without a result file.');
    throw error;
  }
  return validateResult(result, request, jobDir, config);
}

function equal(actual, expected, message, code = 'ADAPTER_PROTOCOL_ERROR') {
  if (canonicalJSON(actual) !== canonicalJSON(expected)) fail(code, message);
}

export async function validateResult(result, request, jobDir, config) {
  try {
    fields(result, ['schemaVersion', 'requestId', 'jobId', 'requestDigest', 'profileId', 'status', 'executionKind', 'executionMode', 'scope', 'validation', 'artifacts'], [], 'adapter result');
    exact(result.schemaVersion, 'calculet.adapter-result/v1', 'result.schemaVersion');
    exact(result.status, 'succeeded', 'result.status');
    for (const key of ['requestId', 'jobId', 'requestDigest', 'profileId']) equal(result[key], request[key], 'Adapter result identity does not match the request.', 'RESULT_IDENTITY_MISMATCH');
    equal(result.executionKind, request.executionKind, 'Adapter execution kind does not match its approved identity.', 'MODE_MISMATCH');
    equal(result.executionMode, 'hybrid', 'Only the approved HYBRID execution mode is allowed.', 'MODE_MISMATCH');
    equal(result.scope, { npuModules: NPU_MODULES, cpuModules: CPU_MODULES, coreMigrationComplete: false }, 'Adapter CPU/NPU scope changed.', 'MODE_MISMATCH');
    const validation = fields(result.validation, ['level', 'deviceExecution', 'numericValidation', 'imageValidation'], [], 'validation');
    exact(validation.level, 'hybrid-smoke', 'validation.level');
    const device = fields(validation.deviceExecution, ['status', 'npuCallCount', 'npuFallbackCount', 'traceArtifactId'], [], 'deviceExecution');
    equal(device.status, request.executionKind === 'hardware' ? 'passed' : 'simulated', 'Device evidence does not match the execution identity.', 'MODE_MISMATCH');
    equal(device.npuCallCount, 4, 'The profile requires exactly four reported Q-projection calls.');
    equal(device.npuFallbackCount, 0, 'NPU compute fallback is not permitted.');
    const numeric = fields(validation.numericValidation, ['status'], ['metricsArtifactId'], 'numericValidation');
    if (!['not_run', 'passed'].includes(numeric.status)) fail('NUMERIC_VALIDATION_FAILED', 'Numeric validation did not pass or was reported incorrectly.');
    if (numeric.status === 'not_run' && numeric.metricsArtifactId !== undefined) fail('ADAPTER_PROTOCOL_ERROR', 'Unrun numeric validation cannot include passed metrics.');
    const image = fields(validation.imageValidation, ['status', 'artifactId', 'width', 'height'], [], 'imageValidation');
    equal(image, { status: 'passed', artifactId: image.artifactId, width: 256, height: 256 }, 'Image validation does not match the fixed profile.');
    if (!Array.isArray(result.artifacts) || result.artifacts.length < 3 || result.artifacts.length > 4) fail('ADAPTER_PROTOCOL_ERROR', 'Success requires PNG, device trace, and an evidence index.');
    const ids = new Set();
    const roles = new Set();
    const paths = new Set();
    const buffers = new Map();
    for (const artifact of result.artifacts) {
      fields(artifact, ['id', 'role', 'path', 'mimeType', 'sha256'], [], 'artifact');
      identifier(artifact.id, 'artifact.id');
      digestValue(artifact.sha256);
      relativePath(artifact.path);
      if (!artifact.path.startsWith('artifacts/')) fail('UNSAFE_PATH', 'Artifacts must be inside the task artifacts directory.');
      if (!['image', 'device_trace', 'evidence_index', 'metrics'].includes(artifact.role) || ids.has(artifact.id) || roles.has(artifact.role) || paths.has(artifact.path.toLowerCase())) fail('ADAPTER_PROTOCOL_ERROR', 'Artifact identifiers, roles, and paths must be unique and supported.');
      if (!['image/png', 'application/json', 'text/plain'].includes(artifact.mimeType)) fail('ADAPTER_PROTOCOL_ERROR', 'Unsupported artifact media type.');
      ids.add(artifact.id); roles.add(artifact.role); paths.add(artifact.path.toLowerCase());
      const target = await containedFile(jobDir, artifact.path);
      const bytes = await readFileSafe(target, artifact.role === 'evidence_index' ? config.maxResultBytes : config.maxArtifactBytes);
      if (sha256(bytes) !== artifact.sha256) fail('ARTIFACT_DIGEST_MISMATCH', 'An artifact does not match its declared SHA-256.');
      if (!bytes.length) fail('ADAPTER_PROTOCOL_ERROR', 'Success artifacts cannot be empty.');
      buffers.set(artifact.id, bytes);
    }
    for (const role of ['image', 'device_trace', 'evidence_index']) if (!roles.has(role)) fail('ADAPTER_PROTOCOL_ERROR', 'Required success evidence is missing.');
    const imageArtifact = result.artifacts.find(a => a.role === 'image');
    if (imageArtifact.id !== image.artifactId || imageArtifact.mimeType !== 'image/png') fail('ADAPTER_PROTOCOL_ERROR', 'Image evidence points to the wrong artifact.');
    validatePNG(buffers.get(imageArtifact.id));
    const trace = result.artifacts.find(a => a.role === 'device_trace');
    if (trace.id !== device.traceArtifactId || !['application/json', 'text/plain'].includes(trace.mimeType)) fail('ADAPTER_PROTOCOL_ERROR', 'Device evidence points to the wrong trace.');
    if (trace.mimeType === 'application/json') {
      const data = parseJSON(buffers.get(trace.id), 'ADAPTER_PROTOCOL_ERROR');
      if (data === null || typeof data !== 'object' || Object.keys(data).length === 0) fail('ADAPTER_PROTOCOL_ERROR', 'Device trace JSON must be a nonempty object or array.');
    } else {
      let data;
      try { data = new TextDecoder('utf-8', { fatal: true }).decode(buffers.get(trace.id)); }
      catch { fail('ADAPTER_PROTOCOL_ERROR', 'Device trace must be UTF-8.'); }
      if (!data.trim()) fail('ADAPTER_PROTOCOL_ERROR', 'Device trace must not be blank.');
    }
    const metrics = result.artifacts.find(a => a.role === 'metrics');
    if (numeric.status === 'passed') {
      if (!metrics || metrics.id !== numeric.metricsArtifactId || metrics.mimeType !== 'application/json') fail('ADAPTER_PROTOCOL_ERROR', 'Passed numeric validation requires metrics evidence.');
      const data = parseJSON(buffers.get(metrics.id), 'ADAPTER_PROTOCOL_ERROR');
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) fail('ADAPTER_PROTOCOL_ERROR', 'Numeric metrics must be a nonempty JSON object.');
    } else if (metrics) fail('ADAPTER_PROTOCOL_ERROR', 'Metrics without performed numeric validation are inconsistent.');
    const index = result.artifacts.find(a => a.role === 'evidence_index');
    if (index.mimeType !== 'application/json') fail('ADAPTER_PROTOCOL_ERROR', 'Evidence index must be JSON.');
    const expected = {
      schemaVersion: 'calculet.evidence-index/v1', jobId: request.jobId, requestDigest: request.requestDigest,
      executionKind: request.executionKind, executionMode: 'hybrid', artifacts: result.artifacts.filter(a => a.role !== 'evidence_index'),
    };
    equal(parseJSON(buffers.get(index.id), 'ADAPTER_PROTOCOL_ERROR'), expected, 'Evidence index does not match the result.');
    return { artifacts: structuredClone(result.artifacts), evidence: { source: 'validated_adapter_report', ...structuredClone(validation), evidenceIndexArtifactId: index.id } };
  } catch (error) {
    if (error instanceof DeploymentError && !['INVALID_REQUEST', 'UNSUPPORTED_RECIPE'].includes(error.code)) throw error;
    fail('ADAPTER_PROTOCOL_ERROR', 'The adapter result does not satisfy the versioned file contract.');
  }
}
