import argparse
import copy
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import uuid
import zlib


PROFILE = 'sd35-qproj-hybrid-smoke-v1'
RECIPE = PROFILE + '.0'
REQUEST_SCHEMA = 'calculet.adapter-request/v1'
RESULT_SCHEMA = 'calculet.adapter-result/v1'
SHARED_BOARD_LOCK = '/opt/data/locks/board.lock'
IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
DIGEST = re.compile(r'[a-f0-9]{64}\Z')
NPU_MODULES = ['transformer_blocks[0].attn.to_q']
CPU_MODULES = ['text_encoders', 'transformer_except_npu_modules', 'scheduler', 'vae_decoder']
PARAMETERS = {'prompt': 'A red apple on a wooden table, soft natural window light, realistic photograph', 'seed': 20261115, 'width': 256, 'height': 256, 'batch': 1, 'steps': 4, 'guidanceScale': 1, 'enableT5': False}
SPEC = {'schemaVersion': 'calculet.task/v1', 'intent': 'deploy-and-validate', 'modelId': 'sd35-medium', 'profileId': PROFILE, 'parameters': PARAMETERS, 'constraints': {'executionMode': 'hybrid', 'requireFullNpu': False, 'allowNpuComputeFallback': False}, 'acceptance': {'level': 'hybrid-smoke'}}
REQUEST_SCOPE = {'executionMode': 'hybrid', 'npuModules': NPU_MODULES, 'cpuModules': CPU_MODULES, 'coreMigrationComplete': False, 'validationLevel': 'hybrid-smoke'}
RESULT_SCOPE = {'npuModules': NPU_MODULES, 'cpuModules': CPU_MODULES, 'coreMigrationComplete': False}


class BridgeError(ValueError):
    def __init__(self, code, message, exit_code=2):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def fail(code, message, exit_code=2):
    raise BridgeError(code, message, exit_code)


def fields(value, expected, label):
    if not isinstance(value, dict) or set(value) != set(expected):
        fail('INVALID_REQUEST', label + ' has missing or unknown fields')
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('INVALID_JSON', 'Duplicate JSON keys are not accepted')
        result[key] = value
    return result


def parse_json(raw):
    def bad_number(_value):
        fail('INVALID_JSON', 'Nonfinite JSON values are not accepted')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object, parse_constant=bad_number)
    except (UnicodeError, json.JSONDecodeError):
        fail('INVALID_JSON', 'Expected a valid UTF-8 JSON document')


def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if type(value) is float:
        if not math.isfinite(value) or not value.is_integer() or abs(value) > 2**53 - 1:
            fail('UNSUPPORTED_NUMBER', 'This fixed profile accepts only safe integral JSON numbers')
        return int(value)
    return value


def canonical_json(value):
    try:
        return json.dumps(canonical(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (UnicodeError, ValueError):
        fail('INVALID_JSON', 'Unsupported string or number encoding')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def regular(path, maximum):
    if path.is_symlink():
        fail('UNSAFE_PATH', 'Symbolic links are not accepted here')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
        fail('UNSAFE_PATH', 'Expected a bounded single-link regular file')
    return info


def directory(path):
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        fail('UNSAFE_PATH', 'Expected an existing absolute non-symlink directory')
    return path.resolve()


def relative_file(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or '\0' in value:
        fail('UNSAFE_PATH', 'Invalid relative component path')
    path = PurePosixPath(value)
    if not path.parts or path.is_absolute() or '..' in path.parts or '.' in path.parts or path.as_posix() != value:
        fail('UNSAFE_PATH', 'Invalid normalized relative component path')
    for part in path.parts:
        if part.endswith(('.', ' ')) or re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part):
            fail('UNSAFE_PATH', 'Reserved path component')
    return path


def timestamp(value):
    if not isinstance(value, str):
        fail('INVALID_WINDOW', 'Expected an ISO timestamp')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        fail('INVALID_WINDOW', 'Invalid ISO timestamp')
    if result.tzinfo is None:
        fail('INVALID_WINDOW', 'Timestamps require an explicit timezone')
    return result.astimezone(timezone.utc)


def validate_request(request_path, result_path, now=None):
    now = now or datetime.now(timezone.utc)
    regular(request_path, 1024 * 1024)
    raw = request_path.read_bytes()
    request = parse_json(raw)
    required = ('schemaVersion', 'requestId', 'jobId', 'jobKind', 'planId', 'planDigest', 'recipeVersion', 'profileId', 'executionKind', 'spec', 'scope', 'paths', 'limits', 'authorization', 'requestDigest')
    fields(request, required, 'request')
    if request['schemaVersion'] != REQUEST_SCHEMA or request['profileId'] != PROFILE or request['recipeVersion'] != RECIPE or request['jobKind'] not in ('deployment', 'generation'):
        fail('UNSUPPORTED_PROFILE', 'Request is not the fixed Q-hybrid recipe')
    for key in ('requestId', 'jobId', 'planId'):
        if not isinstance(request[key], str) or not IDENTIFIER.fullmatch(request[key]):
            fail('INVALID_IDENTITY', 'Invalid request identity')
    for key in ('requestDigest', 'planDigest'):
        if not isinstance(request[key], str) or not DIGEST.fullmatch(request[key]):
            fail('INVALID_IDENTITY', 'Invalid lowercase SHA256 identity')
    if request['executionKind'] != 'hardware':
        fail('UNSUPPORTED_EXECUTION_KIND', 'This real bridge does not implement simulation or replay')
    if canonical_json(request['spec']) != canonical_json(SPEC):
        fail('ADAPTER_INPUT_NOT_SUPPORTED', 'Only the proven complete fixed spec, including the exact prompt and seed, is accepted; no generator was started')
    if canonical_json(request['scope']) != canonical_json(REQUEST_SCOPE):
        fail('INVALID_SCOPE', 'Request CPU/NPU scope differs from the proven hybrid boundary')
    fields(request['paths'], ('jobDir', 'artifactsDir', 'modelRoot', 'components', 'controllerLockPath'), 'paths')
    controller_lock = request['paths']['controllerLockPath']
    if not isinstance(controller_lock, str) or not Path(controller_lock).is_absolute() or '\0' in controller_lock:
        fail('INVALID_LOCK', 'Hardware requests require the service-bound absolute controllerLockPath')
    job = directory(Path(request['paths']['jobDir']))
    artifacts = directory(Path(request['paths']['artifactsDir']))
    model = directory(Path(request['paths']['modelRoot']))
    if request_path.name != 'request.json' or request_path.parent.resolve() != job or result_path.name != 'result.json' or result_path.parent.resolve() != job:
        fail('UNSAFE_PATH', 'Protocol files must be the service-created job request/result files')
    if result_path.exists() or result_path.is_symlink() or artifacts != job / 'artifacts' or any(artifacts.iterdir()):
        fail('STALE_ARTIFACTS', 'Result must be fresh and the service artifacts directory empty')
    components = request['paths']['components']
    if not isinstance(components, list) or not components or len(components) > 10000:
        fail('INVALID_COMPONENTS', 'Expected the controlled service component declarations')
    seen = set()
    for item in components:
        fields(item, ('path', 'sha256'), 'component')
        relative_file(item['path'])
        if item['path'].casefold() in seen or not isinstance(item['sha256'], str) or not DIGEST.fullmatch(item['sha256']):
            fail('INVALID_COMPONENTS', 'Duplicate component or invalid fingerprint')
        seen.add(item['path'].casefold())
    fields(request['limits'], ('timeoutMs', 'deadlineAt'), 'limits')
    budget = request['limits']['timeoutMs']
    if type(budget) is not int or not 10 <= budget <= 3600000 or timestamp(request['limits']['deadlineAt']) <= now:
        fail('REQUEST_DEADLINE_EXPIRED', 'Invalid or expired service execution budget')
    auth = request['authorization']
    if auth is not None:
        fields(auth, ('authorized', 'operatorId', 'authorizationId', 'resourceId', 'windowStart', 'windowEnd', 'sharedDeviceAcknowledged'), 'authorization')
        if type(auth['authorized']) is not bool or type(auth['sharedDeviceAcknowledged']) is not bool:
            fail('INVALID_WINDOW', 'Authorization flags must be booleans')
        for key in ('operatorId', 'authorizationId', 'resourceId'):
            if not isinstance(auth[key], str) or not auth[key].strip() or len(auth[key]) > 128 or '\0' in auth[key]:
                fail('INVALID_WINDOW', 'Invalid operator authorization identity')
        timestamp(auth['windowStart']); timestamp(auth['windowEnd'])
    unsigned = {key: value for key, value in request.items() if key != 'requestDigest'}
    if sha(canonical_json(unsigned)) != request['requestDigest']:
        fail('REQUEST_DIGEST_MISMATCH', 'The request body does not match requestDigest')
    return request, raw, job, artifacts, model


def check_window(request, approved, now=None):
    now = now or datetime.now(timezone.utc)
    auth = request['authorization']
    if not approved or auth is None or auth['authorized'] is not True or auth['sharedDeviceAcknowledged'] is not True:
        fail('DEVICE_WINDOW_REQUIRED', 'SDK configuration is not a new authorized device window', 3)
    if timestamp(auth['windowStart']) > now or timestamp(auth['windowEnd']) < now + timedelta(milliseconds=request['limits']['timeoutMs']):
        fail('DEVICE_WINDOW_CLOSED', 'The operator window does not cover the complete budget', 3)


def reject_obvious_lock_overlap(lock_path, board_lock):
    path = Path(lock_path)
    board = Path(board_lock)
    if not path.is_absolute():
        fail('INVALID_LOCK', 'Cooperation lock must be absolute', 3)
    if path.resolve() == board.resolve() or (path.exists() and board.exists() and os.path.samefile(path, board)):
        fail('DOUBLE_BOARD_LOCK_UNSUPPORTED', 'Control and actual board lock overlap; no lock was deleted or replaced', 3)


def controller_host_identity():
    path = Path('/proc/sys/kernel/random/boot_id')
    try:
        raw = path.read_bytes().strip()
    except OSError:
        fail('HOST_IDENTITY_UNAVAILABLE', 'The controller kernel identity cannot be checked locally', 3)
    if not re.fullmatch(rb'[a-f0-9-]{36}', raw):
        fail('HOST_IDENTITY_UNAVAILABLE', 'Unexpected local kernel identity representation', 3)
    return sha(b'calculet-kernel-boot/v1:' + raw)


def check_lock_topology(request, config, runtime_path, topology_path, expected_sha, local_identity=None):
    lock_path = Path(request['paths']['controllerLockPath'])
    reject_obvious_lock_overlap(lock_path, config['board_lock'])
    regular(lock_path, 1024 * 1024)
    if topology_path is None or not isinstance(expected_sha, str) or not DIGEST.fullmatch(expected_sha):
        fail('LOCK_TOPOLOGY_REQUIRED', 'Different path strings do not prove independent lock domains; operator-pinned topology is required', 3)
    path = Path(topology_path)
    regular(path, 65536)
    if file_sha(path) != expected_sha:
        fail('LOCK_TOPOLOGY_IDENTITY_MISMATCH', 'The operator topology fingerprint changed', 3)
    value = parse_json(path.read_bytes())
    required = ('schemaVersion', 'approved', 'operatorId', 'authorizationId', 'resourceId', 'runtimeConfigSha256', 'controllerHostIdentitySha256', 'workerHostIdentitySha256', 'controllerLockPath', 'workerBoardLockPath', 'lockDomainsReviewedSeparate', 'sharedFilesystemAliasesExcluded', 'workerBoardLockIdentity')
    fields(value, required, 'lock topology')
    auth = request['authorization']
    if value['schemaVersion'] != 'calculet.sd35-lock-topology/v1' or any(value[key] is not True for key in ('approved', 'lockDomainsReviewedSeparate', 'sharedFilesystemAliasesExcluded')):
        fail('LOCK_TOPOLOGY_NOT_APPROVED', 'The operator has not independently reviewed the lock domains and aliases', 3)
    if auth is None or any(value[key] != auth[key] for key in ('operatorId', 'authorizationId', 'resourceId')):
        fail('LOCK_TOPOLOGY_AUTHORIZATION_MISMATCH', 'Topology is not bound to this operator authorization', 3)
    if value['runtimeConfigSha256'] != file_sha(Path(runtime_path)):
        fail('LOCK_TOPOLOGY_RUNTIME_MISMATCH', 'Topology is not bound to the private target/runtime configuration', 3)
    local_identity = local_identity or controller_host_identity()
    for key in ('controllerHostIdentitySha256', 'workerHostIdentitySha256'):
        if not isinstance(value[key], str) or not DIGEST.fullmatch(value[key]):
            fail('INVALID_LOCK_TOPOLOGY', 'Missing approved host identity', 3)
    if value['controllerHostIdentitySha256'] != local_identity or Path(value['controllerLockPath']).resolve() != lock_path.resolve() or value['workerBoardLockPath'] != config['board_lock']:
        fail('LOCK_TOPOLOGY_BINDING_MISMATCH', 'Current host/paths do not match the operator-reviewed topology', 3)
    identity = fields(value['workerBoardLockIdentity'], ('device', 'inode'), 'board lock identity')
    if type(identity['device']) is not int or identity['device'] < 0 or type(identity['inode']) is not int or identity['inode'] <= 0:
        fail('INVALID_LOCK_TOPOLOGY', 'Missing actual board-lock identity', 3)
    if local_identity == value['workerHostIdentitySha256']:
        board = Path(config['board_lock'])
        info = regular(board, 1024 * 1024)
        if info.st_dev != identity['device'] or info.st_ino != identity['inode']:
            fail('BOARD_LOCK_IDENTITY_MISMATCH', 'Same-host actual board-lock identity cannot be confirmed', 3)
        if os.path.samefile(lock_path, board):
            fail('DOUBLE_BOARD_LOCK_UNSUPPORTED', 'Both layers would hold the same board lock', 3)
    return {'topology': 'operator_pinned_local_binding_checked', 'remote_identity_live_checked': False, 'new_device_execution': False}


def authorized_adapter(home, expected_manifest):
    if home is None or not isinstance(expected_manifest, str) or not DIGEST.fullmatch(expected_manifest):
        fail('LOCAL_ADAPTER_REFERENCE_REQUIRED', 'An operator-pinned local authorized adapter is required', 3)
    home = directory(Path(home))
    manifest_path = home / 'bundle-manifest.json'
    regular(manifest_path, 1024 * 1024)
    if file_sha(manifest_path) != expected_manifest:
        fail('ADAPTER_IDENTITY_MISMATCH', 'Authorized adapter manifest fingerprint differs', 3)
    manifest = parse_json(manifest_path.read_bytes())
    total = 0
    for name, expected in manifest['files'].items():
        relative_file(name)
        path = home.joinpath(*PurePosixPath(name).parts)
        if not path.resolve().is_relative_to(home):
            fail('UNSAFE_PATH', 'Adapter dependency escaped the authorized directory', 3)
        info = regular(path, 8 * 1024 * 1024)
        total += info.st_size
        if total > 16 * 1024 * 1024 or info.st_size != expected['bytes'] or file_sha(path) != expected['sha256']:
            fail('ADAPTER_IDENTITY_MISMATCH', 'Authorized adapter dependency fingerprint differs', 3)
    if 'adapter.py' not in manifest['files']:
        fail('ADAPTER_IDENTITY_MISMATCH', 'Authorized entrypoint is not declared', 3)
    specification = importlib.util.spec_from_file_location('_operator_authorized_sd35_adapter', home / 'adapter.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    module.verify_bundle(home)
    return home, module


def validate_png(raw):
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        fail('INVALID_PNG', 'Missing PNG signature', 5)
    offset = 8
    compressed = []
    channels = None
    seen_idat = idat_ended = ended = False
    while offset < len(raw):
        if offset + 12 > len(raw):
            fail('INVALID_PNG', 'Incomplete PNG chunk', 5)
        length = struct.unpack_from('>I', raw, offset)[0]
        end = offset + 12 + length
        if end > len(raw):
            fail('INVALID_PNG', 'Incomplete PNG data', 5)
        kind = raw[offset + 4:offset + 8]
        body = raw[offset + 8:end - 4]
        if not re.fullmatch(rb'[A-Za-z]{4}', kind) or zlib.crc32(kind + body) & 0xffffffff != struct.unpack_from('>I', raw, end - 4)[0]:
            fail('INVALID_PNG', 'PNG type or CRC mismatch', 5)
        if offset == 8 and kind != b'IHDR':
            fail('INVALID_PNG', 'IHDR must be first', 5)
        if kind == b'IHDR':
            if offset != 8 or length != 13:
                fail('INVALID_PNG', 'Invalid IHDR', 5)
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', body)
            if (width, height, depth, compression, filtering, interlace) != (256, 256, 8, 0, 0, 0) or color not in (2, 6):
                fail('INVALID_PNG', 'Expected the fixed RGB/RGBA image profile', 5)
            channels = 3 if color == 2 else 4
        elif kind == b'IDAT':
            if idat_ended:
                fail('INVALID_PNG', 'Nonconsecutive IDAT chunks', 5)
            seen_idat = True
            compressed.append(body)
        else:
            if seen_idat:
                idat_ended = True
            if kind == b'IEND':
                if length or not seen_idat or end != len(raw):
                    fail('INVALID_PNG', 'Invalid PNG ending', 5)
                ended = True
            elif kind == b'PLTE':
                if seen_idat or not length or length > 768 or length % 3:
                    fail('INVALID_PNG', 'Invalid palette', 5)
            elif kind[0] < 97:
                fail('INVALID_PNG', 'Unexpected critical PNG chunk', 5)
        offset = end
    if not ended or channels is None:
        fail('INVALID_PNG', 'Incomplete PNG structure', 5)
    expected = (1 + 256 * channels) * 256
    decoder = zlib.decompressobj()
    try:
        pixels = decoder.decompress(b''.join(compressed), expected + 1)
    except zlib.error:
        fail('INVALID_PNG', 'PNG decompression failed', 5)
    if len(pixels) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or any(pixels[row * (1 + 256 * channels)] > 4 for row in range(256)):
        fail('INVALID_PNG', 'PNG scanline contract failed', 5)
    return 256, 256


def atomic_bytes(path, raw):
    if path.exists() or path.is_symlink():
        fail('STALE_ARTIFACTS', 'Output path is not fresh', 5)
    temporary = path.parent / ('.bridge-' + uuid.uuid4().hex + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # Unlike replace, linking refuses an existing target atomically.
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            fail('STALE_ARTIFACTS', 'Output appeared during atomic publication', 5)
    finally:
        temporary.unlink(missing_ok=True)


def artifact(path, role, identifier, raw):
    atomic_bytes(path, raw)
    return {'id': identifier, 'role': role, 'path': 'artifacts/' + path.name, 'mimeType': 'image/png' if role == 'image' else 'application/json', 'sha256': sha(raw)}


def trace_digest(value):
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        fail('INVALID_RUNTIME_TRACE', 'Runtime trace fingerprints must be lowercase SHA256 values', 5)
    return value


def public_trace(request, report):
    rows = []
    for call, step in zip(report['npu_calls'], report['steps']):
        rows.append({'step': step['step'], 'npuRequestId': call['request_id'], 'module': 'transformer_blocks[0].attn.to_q', 'inputShape': call['input_shape'], 'inputSha256': trace_digest(call['input_sha256']), 'outputSha256': trace_digest(call['output_sha256']), 'rowTiles': call['tile_count'], 'npuFallbackCount': call['compute_cpu_fallback_calls'], 'hostComputeCount': call['compute_host_implementation_calls'], 'deviceClosed': call['device_closed'], 'latentsAfterStepSha256': trace_digest(step['latents_after_npu_dependent_step_sha256'])})
    return {'schemaVersion': 'calculet.device-trace/v1', 'requestId': request['requestId'], 'jobId': request['jobId'], 'requestDigest': request['requestDigest'], 'executionKind': 'hardware', 'executionMode': 'hybrid', 'source': 'validated_adapter_report', 'independentHardwareCertification': False, 'freshInvocation': True, 'scope': copy.deepcopy(RESULT_SCOPE), 'parameters': copy.deepcopy(PARAMETERS), 'generatorSourceSha256': trace_digest(report['generation_source_sha256']), 'workerSourceSha256': trace_digest(report['npu_worker_handshake']['worker_source_sha256']), 'sdkBuildFingerprintSha256': sha(canonical_json(report['npu_calls'][0]['backend_build'])), 'steps': rows}


def publish_result(request, report, private_output, result_path, artifacts):
    image = private_output / 'sd35-medium-hybrid.png'
    regular(image, 32 * 1024 * 1024)
    raw = image.read_bytes()
    if sha(raw) != report['image']['sha256']:
        fail('IMAGE_IDENTITY_MISMATCH', 'New image fingerprint differs', 5)
    width, height = validate_png(raw)
    trace_raw = canonical_json(public_trace(request, report))
    image_entry = artifact(artifacts / 'image.png', 'image', 'image', raw)
    trace_entry = artifact(artifacts / 'device-trace.json', 'device_trace', 'trace', trace_raw)
    indexed = [image_entry, trace_entry]
    index = {'schemaVersion': 'calculet.evidence-index/v1', 'jobId': request['jobId'], 'requestDigest': request['requestDigest'], 'executionKind': 'hardware', 'executionMode': 'hybrid', 'artifacts': indexed}
    evidence_entry = artifact(artifacts / 'evidence-index.json', 'evidence_index', 'evidence', canonical_json(index))
    result = {'schemaVersion': RESULT_SCHEMA, 'requestId': request['requestId'], 'jobId': request['jobId'], 'requestDigest': request['requestDigest'], 'profileId': PROFILE, 'status': 'succeeded', 'executionKind': 'hardware', 'executionMode': 'hybrid', 'scope': copy.deepcopy(RESULT_SCOPE), 'validation': {'level': 'hybrid-smoke', 'deviceExecution': {'status': 'passed', 'npuCallCount': 4, 'npuFallbackCount': 0, 'traceArtifactId': 'trace'}, 'numericValidation': {'status': 'not_run'}, 'imageValidation': {'status': 'passed', 'artifactId': 'image', 'width': width, 'height': height}}, 'artifacts': [*indexed, evidence_entry]}
    atomic_bytes(result_path, canonical_json(result))
    return result


def execute(args):
    request_path, result_path = Path(args.request).absolute(), Path(args.result).absolute()
    request, original, job, artifacts, model = validate_request(request_path, result_path)
    reject_obvious_lock_overlap(request['paths']['controllerLockPath'], SHARED_BOARD_LOCK)
    if args.validate_only:
        fail('VALIDATED_ONLY_NO_DEVICE_EXECUTION', 'Request matches the exact baseline contract; no result or model process was created', 3)
    check_window(request, args.approved_device_window)
    if sys.platform != 'linux':
        fail('NATIVE_LINUX_REQUIRED', 'Live execution requires native Linux; validation remains portable', 3)
    home, adapter = authorized_adapter(args.handoff_dir, args.handoff_manifest_sha256)
    if args.runtime_config is None or args.private_work_root is None:
        fail('PRIVATE_RUNTIME_REQUIRED', 'Operator-owned private runtime references are required', 3)
    config = adapter.parse_config(args.runtime_config)
    if Path(config['model_dir']).resolve() != model:
        fail('MODEL_ROOT_MISMATCH', 'Request modelRoot differs from the fixed operator runtime', 3)
    check_lock_topology(request, config, args.runtime_config, args.lock_topology, args.lock_topology_sha256)
    private_root = directory(Path(args.private_work_root))
    if private_root == job or private_root.is_relative_to(job):
        fail('PRIVATE_LOG_PLACEMENT', 'Private runtime files must remain outside public job artifacts', 3)
    private = Path(tempfile.mkdtemp(prefix='sd35-' + request['jobId'] + '-', dir=private_root))
    config['output_dir'] = str(private / 'model-output')
    config['control_dir'] = str(private / 'adapter-control')
    config['remote_calls'] = str(PurePosixPath(config['remote_calls']).parent / ('request-' + request['requestDigest'][:16] + '-' + uuid.uuid4().hex[:16]))
    runtime = private / 'runtime.private.json'
    descriptor = os.open(runtime, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(config, stream)
    if timestamp(request['limits']['deadlineAt']) <= datetime.now(timezone.utc):
        fail('REQUEST_DEADLINE_EXPIRED', 'The deadline expired before model launch', 3)
    check_window(request, args.approved_device_window)
    command = [sys.executable, '-I', '-B', str(home / 'adapter.py'), 'run', '--config', str(runtime), '--approved-device-window']
    # The service owns the timeout and process group; children must not detach from it.
    with (private / 'bridge-stdout.private.log').open('x') as stdout, (private / 'bridge-stderr.private.log').open('x') as stderr:
        process = subprocess.run(command, stdout=stdout, stderr=stderr)
    if process.returncode:
        fail('AUTHORIZED_ADAPTER_FAILED', 'The authorized new invocation failed; diagnostics remain operator-local', 4)
    receipt = parse_json((Path(config['control_dir']) / 'adapter-result.json').read_bytes())
    if receipt.get('status') != 'HYBRID_RUN_EVIDENCE_CONSISTENT' or receipt.get('new_child_invocation_completed') is not True:
        fail('NEW_INVOCATION_NOT_CONFIRMED', 'Historical evidence cannot substitute for this task', 5)
    private_output = Path(config['output_dir'])
    adapter.verify_runtime_output(private_output, home)
    report = parse_json((private_output / 'generation.json').read_bytes())
    if request_path.read_bytes() != original or timestamp(request['limits']['deadlineAt']) <= datetime.now(timezone.utc):
        fail('REQUEST_CHANGED_OR_EXPIRED', 'Request changed or the service deadline elapsed', 5)
    if any(artifacts.iterdir()):
        fail('STALE_ARTIFACTS', 'Job artifacts are no longer fresh', 5)
    return publish_result(request, report, private_output, result_path, artifacts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--result', required=True)
    parser.add_argument('--handoff-dir')
    parser.add_argument('--handoff-manifest-sha256')
    parser.add_argument('--runtime-config')
    parser.add_argument('--private-work-root')
    parser.add_argument('--lock-topology')
    parser.add_argument('--lock-topology-sha256')
    parser.add_argument('--approved-device-window', action='store_true')
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    try:
        result = execute(args)
        print(json.dumps({'status': result['status'], 'jobId': result['jobId'], 'deviceExecutionStarted': True}))
        return 0
    except BridgeError as error:
        print(json.dumps({'schemaVersion': 'calculet.bridge-diagnostic/v1', 'code': error.code, 'message': str(error), 'successfulResultWritten': False}), file=sys.stderr)
        return error.exit_code
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'schemaVersion': 'calculet.bridge-diagnostic/v1', 'code': 'LOCAL_BRIDGE_ERROR', 'errorType': type(error).__name__, 'successfulResultWritten': False}), file=sys.stderr)
        return 5


if __name__ == '__main__':
    raise SystemExit(main())
