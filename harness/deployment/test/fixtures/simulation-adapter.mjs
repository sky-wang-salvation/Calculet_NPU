import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../adapter.mjs';
import { sha256, NPU_MODULES, CPU_MODULES, normalizeTaskSpec } from '../../contract.mjs';

const args = process.argv.slice(2);
const mode = args[0] === '--request' ? 'ok' : args[0];
const requestPath = args[args.indexOf('--request') + 1];
const resultPath = args[args.indexOf('--result') + 1];
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
if (request.executionKind !== 'simulation') process.exit(73);
if (!Object.hasOwn(request.paths, 'controllerLockPath') || request.paths.controllerLockPath !== null) process.exit(74);
normalizeTaskSpec(request.spec);
const record = event => {
  if (process.env.FIXTURE_INVOCATIONS) appendFileSync(process.env.FIXTURE_INVOCATIONS, `${JSON.stringify({ event, jobId: request.jobId, pid: process.pid, at: Date.now() })}\n`);
};
record('start');
process.stdout.write('SIMULATION FIXTURE: no model weights, SDK, or NPU were executed.\n');
if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 10000));
if (mode === 'delayed') await new Promise(resolve => setTimeout(resolve, 350));
if (mode === 'nonzero') process.exit(23);
if (mode === 'missing-result') process.exit(0);
if (mode === 'malformed') { writeFileSync(resultPath, '{invalid'); process.exit(0); }
if (mode === 'noisy') process.stdout.write('x'.repeat(200000));
if (mode === 'request-tamper') writeFileSync(requestPath, JSON.stringify({ ...request, jobId: 'tampered' }));

function chunk(type, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(type, 4, 4, 'ascii');
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + bytes.length)), 8 + bytes.length);
  return result;
}
function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(256 * (256 * 3 + 1), 64);
  for (let row = 0; row < 256; row++) raw[row * (256 * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Description\0SIMULATION ONLY - synthetic protocol test image')),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const image = mode === 'invalid-png' ? Buffer.from('Not a PNG; simulation adversarial test') : png();
const artifacts = [];
function add(id, role, name, mimeType, bytes) {
  const relative = `artifacts/${name}`;
  writeFileSync(path.join(request.paths.jobDir, relative), bytes);
  const entry = { id, role, path: relative, mimeType, sha256: sha256(bytes) };
  artifacts.push(entry);
  return entry;
}
add('image', 'image', 'image.png', 'image/png', image);
add('trace', 'device_trace', 'trace.json', 'application/json', Buffer.from(mode === 'empty-trace' ? '' : JSON.stringify({ fixtureOnly: true, executionKind: 'simulation', actualNpuCalls: 0, simulatedCalls: 4 })));
if (mode === 'traversal') artifacts[0].path = '../image.png';
if (mode === 'absolute-path') artifacts[0].path = path.join(request.paths.jobDir, 'artifacts', 'image.png');
if (mode === 'missing-file') artifacts[0].path = 'artifacts/missing.png';
if (mode === 'wrong-hash') artifacts[0].sha256 = '0'.repeat(64);
if (mode === 'symlink-escape') {
  const external = path.join(path.dirname(path.dirname(request.paths.jobDir)), 'escaped-fixture');
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, 'image.png'), image);
  symlinkSync(external, path.join(request.paths.artifactsDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  artifacts[0].path = 'artifacts/escape/image.png';
}
if (mode === 'missing-trace') artifacts.splice(1, 1);
if (mode === 'numeric-passed') add('metrics', 'metrics', 'metrics.json', 'application/json', Buffer.from(JSON.stringify({ fixtureOnly: true, simulatedRelativeError: 0 })));
const index = {
  schemaVersion: 'calculet.evidence-index/v1', jobId: request.jobId, requestDigest: request.requestDigest,
  executionKind: request.executionKind, executionMode: 'hybrid', artifacts: [...artifacts],
};
if (mode === 'index-mismatch') index.jobId = 'another-job';
add('evidence', 'evidence_index', 'index.json', 'application/json', Buffer.from(JSON.stringify(index)));
const result = {
  schemaVersion: 'calculet.adapter-result/v1', requestId: request.requestId, jobId: request.jobId,
  requestDigest: request.requestDigest, profileId: request.profileId, status: 'succeeded',
  executionKind: 'simulation', executionMode: 'hybrid',
  scope: { npuModules: NPU_MODULES, cpuModules: CPU_MODULES, coreMigrationComplete: false },
  validation: {
    level: 'hybrid-smoke', deviceExecution: { status: 'simulated', npuCallCount: 4, npuFallbackCount: 0, traceArtifactId: 'trace' },
    numericValidation: { status: 'not_run' }, imageValidation: { status: 'passed', artifactId: 'image', width: 256, height: 256 },
  }, artifacts,
};
if (mode === 'wrong-schema') result.schemaVersion = 'untrusted/v0';
if (mode === 'wrong-request') result.requestId = 'another-request';
if (mode === 'forged-digest') result.requestDigest = '0'.repeat(64);
if (mode === 'mode-mismatch') result.executionKind = 'hardware';
if (mode === 'scope-mismatch') result.scope.coreMigrationComplete = true;
if (mode === 'device-mode-mismatch') result.validation.deviceExecution.status = 'passed';
if (mode === 'wrong-callcount') result.validation.deviceExecution.npuCallCount = 1;
if (mode === 'fallback') result.validation.deviceExecution.npuFallbackCount = 1;
if (mode === 'numeric-failed') result.validation.numericValidation.status = 'failed';
if (mode === 'numeric-passed') result.validation.numericValidation = { status: 'passed', metricsArtifactId: 'metrics' };
if (mode === 'missing-evidence') delete result.validation;
if (mode === 'extra-field') result.shell = 'not allowed';
writeFileSync(`${resultPath}.tmp`, JSON.stringify(result));
renameSync(`${resultPath}.tmp`, resultPath);
record('end');
