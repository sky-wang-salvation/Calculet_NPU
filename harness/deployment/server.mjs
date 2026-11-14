import http from 'node:http';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_VERSION, GENERATION_VERSION, PROFILE_ID, SCOPE, fields, normalizeTaskSpec,
  buildPlan, applyRequest, specForGeneration, idempotencyKey, identifier, newId,
  digest, sha256, fail, DeploymentError,
} from './contract.mjs';
import { normalizeConfig, loadConfig, inspectRuntime, inputPolicyBlocker } from './config.mjs';
import {
  ensureDirectory, createLock, releaseLock, containedFile, readFileSafe, parseJSON, publicError,
} from './io.mjs';
import { openStore } from './store.mjs';
import { makeAdapterRequest, runAdapter, validateResult } from './adapter.mjs';
import { createArtifactAccess } from './artifact-access.mjs';

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let done = false;
    let bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new DeploymentError('REQUEST_TIMEOUT', 'The request body was not received in time.', 408)), 10000);
    req.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > maxBytes) finish(new DeploymentError('REQUEST_TOO_LARGE', 'The request body exceeds the service limit.', 413));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      try { finish(null, parseJSON(Buffer.concat(chunks, bytes))); }
      catch (error) { finish(error); }
    });
    req.on('aborted', () => finish(new DeploymentError('REQUEST_ABORTED', 'The request was interrupted.', 400)));
    req.on('error', () => finish(new DeploymentError('REQUEST_ABORTED', 'The request could not be read.', 400)));
  });
}

function sendJSON(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': data.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status >= 400 ? { connection: 'close' } : {}),
  });
  res.end(data);
}

function existingJob(state, key, fingerprint) {
  const item = state.idempotency.find(entry => entry.key === key);
  if (!item) return null;
  if (item.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'The idempotency key is already bound to a different request.', 409);
  return state.jobs.find(job => job.id === item.jobId);
}

export async function startService({ config: input = {}, configPath, env = process.env, clock = Date.now } = {}) {
  const config = configPath ? await loadConfig(configPath) : normalizeConfig(input);
  const runtimeEnv = { ...env };
  const token = runtimeEnv[config.apiTokenEnv];
  const tokenDigest = typeof token === 'string' && token.length >= 32 && token.length <= 4096 ? Buffer.from(sha256(token), 'hex') : null;
  const store = await openStore(config.storageDir, clock);
  const activeRequests = new Set();
  let url;
  let artifactAccess;
  let closing = false;
  let closePromise;
  let scheduled = false;
  let poisoned = false;
  let runner = null;
  let activeController = null;
  let ownedDeviceToken = null;
  const nowISO = () => new Date(clock()).toISOString();
  const inspect = () => inspectRuntime(config, runtimeEnv, clock, { ownedDeviceToken });
  const jobDir = id => path.join(store.root, 'jobs', identifier(id));

  function artifactsFor(job) {
    return job.artifacts.map(artifact => ({ id: artifact.id, uri: artifactAccess.issue(job.id, artifact), mimeType: artifact.mimeType }));
  }
  function publicJob(job) {
    if (job.kind === 'generation') {
      return {
        id: job.id, modelId: PROFILE_ID, task: 'text-to-image',
        status: ['blocked', 'reconciling'].includes(job.status) ? 'failed' : job.status,
        executionKind: job.executionKind, artifacts: artifactsFor(job),
        ...(job.error ? { error: job.error } : {}),
      };
    }
    return {
      protocolVersion: DEPLOY_VERSION, id: job.id, planId: job.planId, profileId: PROFILE_ID,
      status: job.status, phase: job.phase, executionKind: job.executionKind,
      executionMode: 'hybrid', coreMigrationComplete: false, validationLevel: 'hybrid-smoke',
      artifacts: artifactsFor(job), createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...(job.error ? { error: job.error } : {}), ...(job.evidence ? { evidence: job.evidence } : {}),
    };
  }
  async function updateJob(id, changes) {
    return store.transact(state => {
      const job = state.jobs.find(item => item.id === id);
      Object.assign(job, changes, { updatedAt: nowISO() });
      return job;
    });
  }
  async function markBlocked(id, error) {
    return updateJob(id, { status: 'blocked', phase: 'blocked', error });
  }
  async function currentCapability() {
    const state = store.snapshot();
    const capability = state.capability;
    if (!capability || poisoned || store.failed) return null;
    const runtime = await inspect();
    if (runtime.blockers.length || digest(runtime.binding) !== digest(capability.binding)) return null;
    const source = state.jobs.find(job => job.id === capability.sourceJobId);
    try {
      const result = parseJSON(await readFileSafe(path.join(jobDir(source.id), 'result.json'), config.maxResultBytes), 'ADAPTER_PROTOCOL_ERROR');
      await validateResult(result, source.request, jobDir(source.id), config);
    } catch { return null; }
    return capability;
  }
  function makeJob(kind, planRow, spec, blocked = null) {
    return {
      id: newId(kind === 'deployment' ? 'deployment' : 'generation'), kind,
      planId: planRow.plan.id, planDigest: planRow.plan.planDigest, planExpiresAt: planRow.plan.expiresAt,
      spec, binding: planRow.binding, status: blocked ? 'blocked' : 'queued', phase: blocked ? 'blocked' : 'queued',
      executionKind: 'not_run', artifacts: [], createdAt: nowISO(), updatedAt: nowISO(),
      ...(blocked ? { error: blocked } : {}),
    };
  }
  function assertQueueCapacity(state) {
    if (poisoned) fail('SERVICE_RECONCILING', 'The execution process must be reconciled before further jobs can be accepted.', 503);
    if (state.jobs.filter(job => ['queued', 'running'].includes(job.status)).length >= config.maxQueueDepth) fail('QUEUE_FULL', 'The bounded execution queue is full.', 429);
  }
  async function createDeployment(body) {
    const input = applyRequest(body);
    const fingerprint = digest({ kind: 'deployment', planId: input.planId, planDigest: input.planDigest });
    const previous = existingJob(store.snapshot(), input.idempotencyKey, fingerprint);
    if (previous) return previous;
    const row = store.snapshot().plans.find(item => item.plan.id === input.planId);
    if (!row) fail('PLAN_NOT_FOUND', 'No plan with this identifier exists.', 404);
    if (row.plan.planDigest !== input.planDigest) fail('PLAN_DIGEST_MISMATCH', 'The supplied digest does not match the stored plan.', 409);
    if (clock() >= Date.parse(row.plan.expiresAt)) fail('PLAN_EXPIRED', 'The plan expired; create a new plan without changing an existing idempotency binding.', 409);
    let blocked = row.plan.status === 'blocked' ? row.plan.blockers[0] : null;
    if (!blocked) {
      const current = await inspect();
      blocked = current.blockers[0] ?? (digest(current.binding) !== digest(row.binding) ? { code: 'PLAN_BINDING_CHANGED', message: 'Runtime identity changed; create a new plan.' } : null);
    }
    const job = await store.transact(state => {
      const concurrent = existingJob(state, input.idempotencyKey, fingerprint);
      if (concurrent) return concurrent;
      if (!blocked) assertQueueCapacity(state);
      const created = makeJob('deployment', row, row.plan.spec, blocked);
      state.jobs.push(created);
      state.idempotency.push({ key: input.idempotencyKey, fingerprint, jobId: created.id });
      return created;
    });
    kick();
    return job;
  }
  async function createGeneration(body, key) {
    const spec = specForGeneration(body);
    const fingerprint = digest({ kind: 'generation', spec });
    if (key !== undefined) {
      idempotencyKey(key);
      const prior = existingJob(store.snapshot(), key, fingerprint);
      if (prior) return prior;
    }
    const unsupported = inputPolicyBlocker(config, spec);
    if (unsupported) fail(unsupported.code, unsupported.message, 409);
    const capability = await currentCapability();
    if (!capability) fail('CAPABILITY_NOT_READY', 'No currently authorized and successfully registered profile is available.', 409);
    const job = await store.transact(state => {
      if (key !== undefined) {
        const prior = existingJob(state, key, fingerprint);
        if (prior) return prior;
      }
      if (!state.capability || state.capability.sourceJobId !== capability.sourceJobId) fail('CAPABILITY_NOT_READY', 'Capability changed while the request was being validated.', 409);
      assertQueueCapacity(state);
      const planRow = state.plans.find(row => row.plan.id === capability.planId);
      const created = makeJob('generation', planRow, spec);
      state.jobs.push(created);
      if (key !== undefined) state.idempotency.push({ key, fingerprint, jobId: created.id });
      return created;
    });
    kick();
    return job;
  }

  async function execute(job) {
    let didLaunch = false;
    let lockToken = null;
    activeController = new AbortController();
    try {
      if (clock() - Date.parse(job.createdAt) >= config.queueWaitTimeoutMs) {
        await markBlocked(job.id, { code: 'QUEUE_WAIT_TIMEOUT', message: 'The job exceeded its queue waiting budget and was not executed.' }); return;
      }
      if (job.kind === 'deployment' && clock() >= Date.parse(job.planExpiresAt)) {
        await markBlocked(job.id, { code: 'PLAN_EXPIRED', message: 'The deployment plan expired before execution.' }); return;
      }
      if (job.kind === 'generation') {
        const capability = store.snapshot().capability;
        if (!capability || capability.planId !== job.planId || digest(capability.binding) !== digest(job.binding)) {
          await markBlocked(job.id, { code: 'CAPABILITY_NOT_READY', message: 'The registered capability was withdrawn before generation could start.' }); return;
        }
      }
      await updateJob(job.id, { status: 'running', phase: 'preflight' });
      const preflight = await inspect();
      const blocker = preflight.blockers[0]
        ?? (digest(preflight.binding) !== digest(job.binding) ? { code: 'PLAN_BINDING_CHANGED', message: 'Runtime identity changed after planning; no computation was started.' } : null)
        ?? inputPolicyBlocker(config, job.spec);
      if (blocker) { await markBlocked(job.id, blocker); return; }
      if (closing) fail('SERVICE_SHUTDOWN', 'The service stopped before computation.');
      if (config.adapter.executionKind === 'hardware') {
        lockToken = newId('device-lock');
        try {
          await createLock(config.resourceLockPath, {
            token: lockToken, pid: process.pid, serviceId: store.instanceId, jobId: job.id,
            authorizationId: config.operatorAuthorization.authorizationId, resourceId: config.operatorAuthorization.resourceId,
            acquiredAt: nowISO(),
          });
        } catch (error) {
          lockToken = null;
          if (error.code === 'EEXIST') { await markBlocked(job.id, { code: 'RESOURCE_BUSY', message: 'The cooperative device lock is already held; no computation was started.' }); return; }
          throw error;
        }
        ownedDeviceToken = lockToken;
      }
      const repeated = await inspect();
      if (repeated.blockers.length || digest(repeated.binding) !== digest(job.binding)) {
        await markBlocked(job.id, repeated.blockers[0] ?? { code: 'PLAN_BINDING_CHANGED', message: 'Runtime identity changed before launch.' }); return;
      }
      await updateJob(job.id, { phase: 'prepare' });
      try { await mkdir(jobDir(job.id), { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('JOB_DIRECTORY_EXISTS', 'A previous task directory exists; reconcile it rather than repeat execution.'); throw error; }
      await ensureDirectory(path.join(jobDir(job.id), 'artifacts'));
      const request = makeAdapterRequest(job, config, jobDir(job.id), clock());
      await updateJob(job.id, { phase: 'run_validation', executionKind: config.adapter.executionKind, request });
      const result = await runAdapter(config, runtimeEnv, jobDir(job.id), request, activeController.signal, { clock, onLaunch: () => { didLaunch = true; } });
      await updateJob(job.id, { phase: 'collect_evidence' });
      if (closing) fail('SERVICE_SHUTDOWN', 'The service stopped before successful registration.');
      await updateJob(job.id, { phase: 'register_capability' });
      await store.transact(state => {
        const row = state.jobs.find(item => item.id === job.id);
        Object.assign(row, { status: 'succeeded', phase: 'complete', artifacts: result.artifacts, evidence: result.evidence, updatedAt: nowISO() });
        delete row.error;
        if (job.kind === 'deployment') {
          state.capability = { sourceJobId: job.id, planId: job.planId, planDigest: job.planDigest, binding: job.binding, executionKind: config.adapter.executionKind, registeredAt: nowISO() };
        }
      });
      if (lockToken) {
        await releaseLock(config.resourceLockPath, lockToken);
        lockToken = null; ownedDeviceToken = null;
      }
    } catch (error) {
      if (error.code === 'ADAPTER_START_FAILED') didLaunch = false;
      const reconciling = ['SERVICE_SHUTDOWN', 'ADAPTER_TERMINATION_UNCONFIRMED', 'JOB_DIRECTORY_EXISTS'].includes(error.code);
      if (error.code === 'ADAPTER_TERMINATION_UNCONFIRMED') poisoned = true;
      await store.transact(state => {
        const row = state.jobs.find(item => item.id === job.id);
        Object.assign(row, {
          status: reconciling ? 'reconciling' : didLaunch ? 'failed' : 'blocked',
          phase: reconciling ? 'reconciling' : didLaunch ? 'failed' : 'blocked',
          error: publicError(error, 'EXECUTION_FAILED'), updatedAt: nowISO(),
          ...(!didLaunch ? { executionKind: 'not_run' } : {}),
        });
        if (didLaunch) state.capability = null;
      }).catch(() => { poisoned = true; });
    } finally {
      if (lockToken && !didLaunch) {
        try { await releaseLock(config.resourceLockPath, lockToken); }
        catch { poisoned = true; }
      }
      ownedDeviceToken = null;
      activeController = null;
    }
  }
  function kick() {
    if (scheduled || runner || closing || poisoned || store.failed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (closing || poisoned || store.failed) return;
      runner = (async () => {
        while (!closing && !poisoned && !store.failed) {
          const next = store.snapshot().jobs.find(job => job.status === 'queued');
          if (!next) break;
          await execute(next);
        }
      })().catch(() => { poisoned = true; }).finally(() => { runner = null; });
    });
  }

  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    const task = handle(req, res).catch(error => {
      sendJSON(res, error instanceof DeploymentError ? error.status : 500, { error: publicError(error) });
    }).finally(() => activeRequests.delete(task));
    activeRequests.add(task);
  });
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });

  async function handle(req, res) {
    if (closing || store.failed) fail('SERVICE_UNAVAILABLE', 'The service is stopping or requires storage reconciliation.', 503);
    if (!url || req.headers.host !== new URL(url).host) fail('INVALID_HOST', 'Use the configured loopback authority.', 400);
    if (!tokenDigest) fail('AUTH_NOT_CONFIGURED', 'Configure a service token of at least 32 characters in the named environment variable.', 503);
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('%') || req.url.includes('\\')) fail('INVALID_PATH', 'Use canonical API paths.', 400);
    const target = new URL(req.url, url);
    if (target.hash || target.pathname !== req.url.split('?')[0]) fail('INVALID_PATH', 'Use canonical API paths.', 400);
    const route = target.pathname;
    const artifactRoute = /^\/v1\/artifacts\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(route);
    let signedArtifact = false;
    if (target.search) {
      if (req.method !== 'GET' || !artifactRoute) fail('INVALID_PATH', 'Signed URL parameters are accepted only for artifact GET requests.', 400);
      const job = store.snapshot().jobs.find(item => item.id === artifactRoute[1] && item.status === 'succeeded');
      const artifact = job?.artifacts.find(item => item.id === artifactRoute[2]);
      artifactAccess.authorize(target, artifact);
      signedArtifact = true;
    } else {
      if (req.headers.origin !== undefined && req.headers.origin !== url) fail('ORIGIN_NOT_ALLOWED', 'Cross-origin API requests are not allowed.', 403);
      const authHeaders = req.rawHeaders.filter((_value, index, headers) => index % 2 === 0 && headers[index].toLowerCase() === 'authorization');
      const header = req.headers.authorization;
      if (authHeaders.length !== 1 || typeof header !== 'string' || !header.startsWith('Bearer ') || !timingSafeEqual(tokenDigest, Buffer.from(sha256(header.slice(7)), 'hex'))) fail('UNAUTHORIZED', 'A valid service Bearer token is required.', 401);
    }
    if (req.method === 'GET' && route === '/v1/capabilities') {
      const capability = await currentCapability();
      sendJSON(res, 200, {
        protocolVersion: GENERATION_VERSION, backendId: 'calculet-controlled-deployment', executionKind: capability?.executionKind ?? 'not_run',
        models: capability ? [{
          id: PROFILE_ID,
          displayName: `SD3.5 Medium Q-projection HYBRID smoke (256×256)${config.adapter.inputPolicy ? ` [fixed prompt; seed=${config.adapter.inputPolicy.seed}]` : ''}`,
          tasks: ['text-to-image'], readiness: 'ready',
        }] : [],
        scope: SCOPE,
        note: 'hybrid-smoke only; adapter-reported device evidence is not independent hardware certification, numeric acceptance, or image-quality approval.'
          + (config.adapter?.inputPolicy ? ` Adapter input restriction: exact configured prompt and seed=${config.adapter.inputPolicy.seed} only; arbitrary input is not supported.` : ''),
      });
      return;
    }
    const lookup = /^\/v1\/(deployment-jobs|jobs)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(route);
    if (req.method === 'GET' && lookup) {
      const kind = lookup[1] === 'jobs' ? 'generation' : 'deployment';
      const job = store.snapshot().jobs.find(item => item.id === lookup[2] && item.kind === kind);
      if (!job) fail('JOB_NOT_FOUND', 'The job does not exist.', 404);
      sendJSON(res, 200, publicJob(job)); return;
    }
    if (req.method === 'GET' && artifactRoute) {
      const job = store.snapshot().jobs.find(item => item.id === artifactRoute[1] && item.status === 'succeeded');
      const artifact = job?.artifacts.find(item => item.id === artifactRoute[2]);
      if (!artifact) fail('ARTIFACT_NOT_FOUND', 'No validated artifact with this identifier exists.', 404);
      const file = await containedFile(jobDir(job.id), artifact.path);
      const bytes = await readFileSafe(file, config.maxArtifactBytes);
      if (sha256(bytes) !== artifact.sha256) fail('ARTIFACT_CHANGED', 'The artifact changed after validation and cannot be served.', 409);
      res.writeHead(200, {
        'content-type': artifact.mimeType, 'content-length': bytes.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${artifact.id}${artifact.mimeType === 'image/png' ? '.png' : artifact.mimeType === 'application/json' ? '.json' : '.txt'}"`,
        'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': signedArtifact ? 'cross-origin' : 'same-origin',
        ...(signedArtifact ? { 'access-control-allow-origin': '*' } : {}),
      });
      res.end(bytes); return;
    }
    if (req.method !== 'POST' || !['/v1/deployment-plans', '/v1/deployment-jobs', '/v1/jobs'].includes(route)) fail('NOT_FOUND', 'No API route matches this request.', 404);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail('UNSUPPORTED_MEDIA_TYPE', 'Send application/json with UTF-8 encoding.', 415);
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail('UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not accepted.', 415);
    if (Number(req.headers['content-length']) > config.maxRequestBytes) fail('REQUEST_TOO_LARGE', 'The request body exceeds the service limit.', 413);
    const body = await readBody(req, config.maxRequestBytes);
    if (route === '/v1/deployment-plans') {
      fields(body, ['spec'], [], 'plan request');
      const spec = normalizeTaskSpec(body.spec);
      const runtime = await inspect();
      const unsupported = inputPolicyBlocker(config, spec);
      const blockers = [...runtime.blockers, ...(unsupported ? [unsupported] : [])];
      const plan = buildPlan(spec, runtime.binding, blockers, { now: clock(), ttlMs: config.planTtlMs });
      await store.transact(state => { state.plans.push({ plan, binding: runtime.binding }); });
      sendJSON(res, 201, plan);
    } else if (route === '/v1/deployment-jobs') sendJSON(res, 202, publicJob(await createDeployment(body)));
    else sendJSON(res, 202, publicJob(await createGeneration(body, req.headers['idempotency-key'])));
  }

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listen.port, config.listen.host, resolve); });
    const address = server.address();
    url = `http://${config.listen.host === '::1' ? '[::1]' : config.listen.host}:${address.port}`;
    artifactAccess = createArtifactAccess({ origin: url, ttlMs: config.artifactUrlTtlMs, clock });
  } catch (error) { await store.close(); throw error; }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      activeController?.abort();
      server.closeAllConnections();
      await Promise.allSettled([...activeRequests]);
      if (runner) await runner;
      if (!store.failed) {
        await store.transact(state => {
          let unfinished = false;
          for (const job of state.jobs) if (['queued', 'running'].includes(job.status)) {
            unfinished = true;
            Object.assign(job, {
              status: 'reconciling', phase: 'reconciling', updatedAt: nowISO(),
              error: { code: 'SERVICE_SHUTDOWN', message: 'The service stopped with unfinished work; this job will not be automatically executed again.' },
            });
          }
          if (unfinished) state.capability = null;
        });
      }
      await stopped;
      await store.close();
    })();
    return closePromise;
  }
  return { url, server, storageDir: store.root, close };
}

async function cli() {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || args.length === 2 && args[0] === '--config')) fail('INVALID_ARGUMENTS', 'Usage: node deployment/server.mjs [--config path-to-config.json]');
  const service = await startService(args.length ? { configPath: path.resolve(args[1]) } : {});
  process.stdout.write(`${JSON.stringify({ service: 'calculet-deployment', url: service.url, execution: 'Requires authenticated plan and explicit approved adapter configuration.' })}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    service.close().catch(error => { process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`); process.exitCode = 1; });
}
