import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile


BRIDGE_SHA256 = 'a8867a2befe3da10716b8b8f5878732e4284ddd8297cb40474ec3381e33df0b9'
SERVICE_SHA256 = 'a62c4ba835a17eee09f1b40044300d8c2a52a0a12bec0a2727982aabfa807506'
NODE_PRODUCER = '''
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const {makeAdapterRequest} = await import(pathToFileURL(process.argv[1]).href);
const input = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(makeAdapterRequest(input.job, input.config, input.jobDir, Date.now())));
'''


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bridge', type=Path, required=True)
    parser.add_argument('--service-module', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    bridge_path = args.bridge.resolve()
    service_path = args.service_module.resolve()
    if digest(bridge_path.read_bytes()) != BRIDGE_SHA256 or digest(service_path.read_bytes()) != SERVICE_SHA256:
        raise ValueError('The tested frozen source identity changed')
    module_spec = importlib.util.spec_from_file_location('frozen_bridge_under_test', bridge_path)
    bridge = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(bridge)
    cases = []
    with tempfile.TemporaryDirectory(prefix='sd35-protocol-only-') as temporary:
        root = Path(temporary).resolve()
        job = root / 'job'; job.mkdir()
        artifacts = job / 'artifacts'; artifacts.mkdir()
        model = root / 'synthetic-model-manifest-only'; model.mkdir()
        manifest = b'{"syntheticFixture":true,"modelWeightsPresent":false}\n'
        (model / 'manifest.json').write_bytes(manifest)
        lock = root / 'synthetic-controller.lock'; lock.write_bytes(b'offline fixture, not a device lock\n')
        board = root / 'synthetic-board.lock'; board.write_bytes(b'offline fixture, not a device lock\n')
        request_path = job / 'request.json'
        result_path = job / 'result.json'
        now = datetime.now(timezone.utc)
        producer_input = {
            'job': {'id': 'deployment-offline-fixture', 'kind': 'deployment', 'planId': 'plan-offline-fixture', 'planDigest': '1' * 64, 'spec': copy.deepcopy(bridge.SPEC), 'binding': {'modelRoot': str(model)}},
            'config': {'adapter': {'executionKind': 'hardware', 'timeoutMs': 120000, 'components': [{'path': 'manifest.json', 'sha256': digest(manifest)}]}, 'resourceLockPath': str(lock), 'operatorAuthorization': {'authorized': True, 'operatorId': 'synthetic-not-an-operator-approval', 'authorizationId': 'synthetic-not-a-real-window', 'resourceId': 'synthetic-not-a-device', 'windowStart': iso(now - timedelta(minutes=1)), 'windowEnd': iso(now + timedelta(minutes=10)), 'sharedDeviceAcknowledged': True}},
            'jobDir': str(job),
        }

        def produce(kind):
            value = copy.deepcopy(producer_input)
            value['job']['kind'] = kind
            child = subprocess.run(['node', '--input-type=module', '-e', NODE_PRODUCER, str(service_path)], input=json.dumps(value), capture_output=True, text=True, timeout=15)
            if child.returncode:
                raise RuntimeError(child.stderr)
            return json.loads(child.stdout)

        def seal(value):
            value['requestDigest'] = digest(bridge.canonical_json({key: item for key, item in value.items() if key != 'requestDigest'}))
            return value

        def check(name, value, expected_exit, expected_code, validation_only=True):
            raw = json.dumps(value, ensure_ascii=False).encode('utf-8')
            request_path.write_bytes(raw)
            argv = [sys.executable, '-I', '-B', str(bridge_path), '--request', str(request_path), '--result', str(result_path)]
            if validation_only:
                argv.append('--validate-only')
            child = subprocess.run(argv, capture_output=True, text=True, timeout=15)
            try:
                diagnostic = json.loads(child.stderr)
            except ValueError:
                diagnostic = {}
            unchanged = request_path.read_bytes() == raw
            no_output = not result_path.exists() and not list(artifacts.iterdir())
            passed = child.returncode == expected_exit and diagnostic.get('code') == expected_code and unchanged and no_output
            cases.append({'name': name, 'passed': passed, 'exitCode': child.returncode, 'diagnosticCode': diagnostic.get('code'), 'requestUnchanged': unchanged, 'resultOrArtifactsCreated': not no_output})

        request = produce('deployment')
        check('production_deployment_request_validate_only', request, 3, 'VALIDATED_ONLY_NO_DEVICE_EXECUTION')
        check('production_generation_request_validate_only', produce('generation'), 3, 'VALIDATED_ONLY_NO_DEVICE_EXECUTION')
        changed = copy.deepcopy(request); del changed['paths']['controllerLockPath']
        check('missing_controller_lock_field', seal(changed), 2, 'INVALID_REQUEST')
        for label, invalid in [('null', None), ('boolean', True), ('number', 0), ('array', []), ('object', {}), ('empty', ''), ('relative', 'relative.lock')]:
            changed = copy.deepcopy(request); changed['paths']['controllerLockPath'] = invalid
            check('invalid_controller_lock_' + label, seal(changed), 2, 'INVALID_LOCK')
        for key, value in [('prompt', 'unsupported offline fixture prompt'), ('seed', 1)]:
            changed = copy.deepcopy(request); changed['spec']['parameters'][key] = value
            check('unsupported_' + key, seal(changed), 2, 'ADAPTER_INPUT_NOT_SUPPORTED')
        changed = copy.deepcopy(request); changed['paths']['controllerLockPath'] = str(root / 'other-controller.lock')
        check('controller_lock_tamper_without_resigning', changed, 2, 'REQUEST_DIGEST_MISMATCH')
        check('no_device_window_flag_no_model_launch', request, 3, 'DEVICE_WINDOW_REQUIRED', validation_only=False)
        changed = copy.deepcopy(request); changed['executionKind'] = 'simulation'; changed['authorization'] = None; changed['paths']['controllerLockPath'] = None
        check('real_bridge_refuses_simulation', seal(changed), 2, 'UNSUPPORTED_EXECUTION_KIND')

        for name, invocation, expected in [
            ('same_lock_overlap_is_rejected_without_deletion', lambda: bridge.reject_obvious_lock_overlap(str(lock), str(lock)), 'DOUBLE_BOARD_LOCK_UNSUPPORTED'),
            ('different_paths_without_topology_are_rejected', lambda: bridge.check_lock_topology(request, {'board_lock': str(board)}, root / 'unused-runtime', None, None, local_identity='f' * 64), 'LOCK_TOPOLOGY_REQUIRED'),
        ]:
            try:
                invocation()
                code = None
            except bridge.BridgeError as error:
                code = error.code
            preserved = lock.exists() and board.exists()
            cases.append({'name': name, 'passed': code == expected and preserved, 'diagnosticCode': code, 'syntheticLockFilesPreserved': preserved})

    report = {
        'schemaVersion': 'calculet.sd35-production-request-acceptance/v1',
        'classification': 'OFFLINE_PROTOCOL_ONLY_NOT_HARDWARE_ACCEPTANCE',
        'status': 'passed' if all(case['passed'] for case in cases) else 'failed',
        'producer': 'Frozen harness/deployment/adapter.mjs:makeAdapterRequest',
        'bridgeSha256': BRIDGE_SHA256,
        'serviceSourceSha256': SERVICE_SHA256,
        'verifierSourceSha256': digest(Path(__file__).read_bytes()),
        'caseCount': len(cases),
        'passedCount': sum(case['passed'] for case in cases),
        'cases': cases,
        'fixedApprovalFlagSupplied': False,
        'syntheticAuthorizationIsRealApproval': False,
        'sdkImported': False,
        'modelSubprocessStarted': False,
        'actualHardwareCalls': 0,
        'realTopologyVerified': False,
        'httpServiceOrWatchdogExercised': False,
        'temporaryFixturesDeleted': True,
        'existingBridgeBundleModified': False,
    }
    with args.report.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'status': report['status'], 'cases': report['caseCount'], 'passed': report['passedCount'], 'reportSha256': digest(args.report.read_bytes()), 'verifierSourceSha256': report['verifierSourceSha256'], 'hardwareCalls': 0}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
