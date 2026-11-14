import path from 'node:path';
import { fields, identifier, normalizeTaskSpec, digestValue, fail, newId } from './contract.mjs';
import { ensureDirectory, acquireServiceLock, readFileSafe, parseJSON, atomicJSON } from './io.mjs';

const VERSION = 'calculet.deployment-state/v1';
const MAX_BYTES = 16777216;
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'reconciling'];

function checkState(state) {
  fields(state, ['schemaVersion', 'plans', 'jobs', 'idempotency', 'capability'], [], 'state');
  if (state.schemaVersion !== VERSION || !Array.isArray(state.plans) || !Array.isArray(state.jobs) || !Array.isArray(state.idempotency)
    || state.plans.length > 1000 || state.jobs.length > 1000 || state.idempotency.length > 1000) fail('STATE_CORRUPT', 'Unsupported or oversized persistent state.');
  const planIds = new Set();
  for (const row of state.plans) {
    identifier(row.plan.id);
    if (planIds.has(row.plan.id)) fail('STATE_CORRUPT', 'Duplicate persistent plan.');
    planIds.add(row.plan.id);
    digestValue(row.plan.planDigest);
    normalizeTaskSpec(row.plan.spec);
    if (!['ready', 'blocked'].includes(row.plan.status) || !Number.isFinite(Date.parse(row.plan.expiresAt))) fail('STATE_CORRUPT', 'Invalid persistent plan.');
  }
  const jobIds = new Set();
  for (const row of state.jobs) {
    identifier(row.id);
    if (jobIds.has(row.id)) fail('STATE_CORRUPT', 'Duplicate persistent job.');
    jobIds.add(row.id);
    if (!planIds.has(row.planId) || !['deployment', 'generation'].includes(row.kind) || !STATUSES.includes(row.status)
      || !['not_run', 'simulation', 'hardware'].includes(row.executionKind) || !Array.isArray(row.artifacts)
      || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.updatedAt))) fail('STATE_CORRUPT', 'Invalid persistent job.');
    normalizeTaskSpec(row.spec);
    digestValue(row.planDigest);
    for (const artifact of row.artifacts) { identifier(artifact.id); digestValue(artifact.sha256); }
    if (['failed', 'blocked', 'reconciling'].includes(row.status) && (typeof row.error?.code !== 'string' || typeof row.error?.message !== 'string')) fail('STATE_CORRUPT', 'A persisted failure must explain its state.');
    if (row.status === 'succeeded' && (!row.request || !row.evidence || row.executionKind === 'not_run' || row.artifacts.length < 3)) fail('STATE_CORRUPT', 'A persisted success must include evidence.');
  }
  const keys = new Set();
  for (const row of state.idempotency) {
    if (typeof row.key !== 'string' || keys.has(row.key) || !jobIds.has(row.jobId)) fail('STATE_CORRUPT', 'Invalid persistent idempotency index.');
    keys.add(row.key);
    digestValue(row.fingerprint);
  }
  if (state.capability !== null && !state.jobs.some(job => job.id === state.capability.sourceJobId && job.kind === 'deployment' && job.status === 'succeeded')) fail('STATE_CORRUPT', 'Capability provenance is invalid.');
}

export async function openStore(storageDir, clock) {
  const root = await ensureDirectory(storageDir);
  const unlock = await acquireServiceLock(root);
  let state;
  const file = path.join(root, 'state.json');
  try {
    await ensureDirectory(path.join(root, 'jobs'));
    try { state = parseJSON(await readFileSafe(file, MAX_BYTES), 'STATE_CORRUPT'); checkState(state); }
    catch (error) {
      if (error.code !== 'ENOENT') fail('STATE_CORRUPT', 'Persistent state is invalid or unreadable; execution is disabled until operator review.', 503);
      state = { schemaVersion: VERSION, plans: [], jobs: [], idempotency: [], capability: null };
    }
    let recovered = false;
    for (const job of state.jobs) {
      if (['queued', 'running'].includes(job.status)) {
        recovered = true;
        job.status = 'reconciling'; job.phase = 'reconciling'; job.updatedAt = new Date(clock()).toISOString();
        job.error = { code: 'RESTART_RECONCILIATION_REQUIRED', message: 'The service restarted with unfinished work; it will not automatically execute this job again.' };
      }
    }
    if (recovered) state.capability = null;
    await atomicJSON(file, state);
  } catch (error) { await unlock(); throw error; }
  let serial = Promise.resolve();
  const store = {
    root, failed: false,
    snapshot: () => structuredClone(state),
    transact(callback) {
      const pending = serial.then(async () => {
        if (store.failed) fail('STORE_UNAVAILABLE', 'State persistence failed; the service must be reconciled.', 503);
        const next = structuredClone(state);
        const result = await callback(next);
        if (next.plans.length > 1000 || next.jobs.length > 1000 || Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) fail('STORE_CAPACITY', 'The private store reached its retention limit; operator archival is required.', 507);
        try { await atomicJSON(file, next); }
        catch (error) { store.failed = true; throw error; }
        state = next;
        return structuredClone(result);
      });
      serial = pending.catch(() => {});
      return pending;
    },
    async close() { await serial; await unlock(); },
    instanceId: newId('service'),
  };
  return store;
}
