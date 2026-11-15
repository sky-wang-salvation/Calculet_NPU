import copy
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock
import zlib

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sd35_protocol_bridge', ROOT / 'service_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def seal(value):
    value['requestDigest'] = bridge.sha(bridge.canonical_json({key: child for key, child in value.items() if key != 'requestDigest'}))
    return value


def png_fixture(width=256, height=256, filtering=0, extra_rows=0):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    rows = (bytes([filtering]) + bytes([16, 32, 48]) * width) * (height + extra_rows)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def runtime_fixture(image):
    calls, steps = [], []
    for index in range(4):
        calls.append({'request_id': index + 1, 'input_shape': [1, 256, 1536], 'input_sha256': 'a' * 64, 'output_sha256': 'b' * 64, 'tile_count': 16, 'compute_cpu_fallback_calls': 0, 'compute_host_implementation_calls': 0, 'device_closed': True, 'backend_build': {'version': 'unit-fixture'}, 'private_process_snapshot': 'DO_NOT_EXPOSE_PRIVATE_MARKER', 'device_info': {'private_address': 'DO_NOT_EXPOSE_PRIVATE_MARKER'}})
        steps.append({'step': index, 'latents_after_npu_dependent_step_sha256': 'c' * 64})
    return {'npu_calls': calls, 'steps': steps, 'generation_source_sha256': 'd' * 64, 'npu_worker_handshake': {'worker_source_sha256': 'e' * 64}, 'image': {'sha256': bridge.sha(image)}, 'authorization': 'DO_NOT_EXPOSE_PRIVATE_MARKER'}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.job = self.root / 'job-example'; self.job.mkdir()
        self.artifacts = self.job / 'artifacts'; self.artifacts.mkdir()
        self.model = self.root / 'model'; self.model.mkdir()
        self.lock = self.root / 'service-cooperation.lock'; self.lock.write_bytes(b'unit-only cooperation owner')
        self.request_path = self.job / 'request.json'
        self.result_path = self.job / 'result.json'
        self.now = datetime.now(timezone.utc)
        self.request = seal({'schemaVersion': bridge.REQUEST_SCHEMA, 'requestId': 'request-example', 'jobId': 'job-example', 'jobKind': 'deployment', 'planId': 'plan-example', 'planDigest': '1' * 64, 'recipeVersion': bridge.RECIPE, 'profileId': bridge.PROFILE, 'executionKind': 'hardware', 'spec': copy.deepcopy(bridge.SPEC), 'scope': copy.deepcopy(bridge.REQUEST_SCOPE), 'paths': {'jobDir': str(self.job), 'artifactsDir': str(self.artifacts), 'modelRoot': str(self.model), 'components': [{'path': 'manifest.json', 'sha256': '2' * 64}], 'controllerLockPath': str(self.lock)}, 'limits': {'timeoutMs': 120000, 'deadlineAt': iso(self.now + timedelta(seconds=120))}, 'authorization': {'authorized': True, 'operatorId': 'unit-operator', 'authorizationId': 'unit-window', 'resourceId': 'unit-resource', 'windowStart': iso(self.now - timedelta(minutes=1)), 'windowEnd': iso(self.now + timedelta(minutes=10)), 'sharedDeviceAcknowledged': True}})
        self.write_request()

    def write_request(self, value=None):
        value = self.request if value is None else value
        self.request_path.write_bytes(json.dumps(value, ensure_ascii=False, indent=2).encode())

    def args(self, **values):
        result = {'request': str(self.request_path), 'result': str(self.result_path), 'validate_only': False, 'approved_device_window': False, 'handoff_dir': None, 'handoff_manifest_sha256': None, 'runtime_config': None, 'private_work_root': None, 'lock_topology': None, 'lock_topology_sha256': None}
        result.update(values)
        return SimpleNamespace(**result)

    def validate(self):
        return bridge.validate_request(self.request_path, self.result_path, self.now)

    def test_complete_request_and_controller_lock_field_are_accepted(self):
        request, raw, job, artifacts, model = self.validate()
        self.assertEqual(request, self.request)
        self.assertEqual(raw, self.request_path.read_bytes())
        self.assertEqual((job, artifacts, model), (self.job.resolve(), self.artifacts.resolve(), self.model.resolve()))

    def test_canonical_json_matches_stringify_integral_and_unicode_rules(self):
        value = {'z': [1.0, True, '中文'], 'a': {'b': 'x\\y'}}
        self.assertEqual(bridge.canonical_json(value), '{"a":{"b":"x\\\\y"},"z":[1,true,"中文"]}'.encode())

    @unittest.skipUnless(shutil.which('node'), 'Node unavailable; fixed Python golden still checked')
    def test_request_digest_matches_actual_node_recursive_canonicalization(self):
        code = 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const c=v=>Array.isArray(v)?"["+v.map(c).join(",")+"]":v!==null&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+c(v[k])).join(",")+"}":JSON.stringify(v);console.log(require("crypto").createHash("sha256").update(c(JSON.parse(s))).digest("hex"))})'
        unsigned = {key: value for key, value in self.request.items() if key != 'requestDigest'}
        result = subprocess.run(['node', '-e', code], input=json.dumps(unsigned, ensure_ascii=False), capture_output=True, text=True, check=True, timeout=10)
        self.assertEqual(result.stdout.strip(), self.request['requestDigest'])

    def test_request_digest_tamper_is_rejected(self):
        self.request['planId'] = 'different-plan'; self.write_request()
        with self.assertRaisesRegex(bridge.BridgeError, 'requestDigest'):
            self.validate()

    def test_missing_controller_lock_field_is_rejected(self):
        del self.request['paths']['controllerLockPath']; seal(self.request); self.write_request()
        with self.assertRaises(bridge.BridgeError):
            self.validate()

    def test_controller_path_change_is_covered_by_digest(self):
        self.request['paths']['controllerLockPath'] = str(self.root / 'different.lock'); self.write_request()
        with self.assertRaisesRegex(bridge.BridgeError, 'requestDigest'):
            self.validate()

    def test_other_prompt_seed_and_complete_spec_changes_are_rejected_before_child(self):
        changes = [('prompt', 'a different prompt'), ('seed', 1), ('width', 512), ('steps', 8), ('enableT5', True), ('guidanceScale', True)]
        for key, value in changes:
            changed = copy.deepcopy(self.request)
            changed['spec']['parameters'][key] = value; seal(changed); self.write_request(changed)
            with self.subTest(field=key), mock.patch.object(bridge.subprocess, 'run') as child, mock.patch.object(bridge, 'authorized_adapter') as adapter:
                with self.assertRaises(bridge.BridgeError) as error:
                    bridge.execute(self.args())
                self.assertEqual(error.exception.code, 'ADAPTER_INPUT_NOT_SUPPORTED')
                child.assert_not_called(); adapter.assert_not_called()
                self.assertFalse(self.result_path.exists())
                self.assertEqual(list(self.artifacts.iterdir()), [])

    def test_unknown_nested_spec_and_scope_fields_are_rejected(self):
        for group in ('spec', 'scope'):
            changed = copy.deepcopy(self.request); changed[group]['unexpected'] = True
            seal(changed); self.write_request(changed)
            with self.subTest(group=group), self.assertRaises(bridge.BridgeError):
                self.validate()

    def test_simulation_and_replay_not_implemented_by_real_bridge(self):
        self.request['executionKind'] = 'simulation'
        self.request['authorization'] = None; self.request['paths']['controllerLockPath'] = None
        seal(self.request); self.write_request()
        with self.assertRaises(bridge.BridgeError) as error:
            self.validate()
        self.assertEqual(error.exception.code, 'UNSUPPORTED_EXECUTION_KIND')

    def test_validation_only_never_imports_adapter_spawns_or_writes_success(self):
        before = self.request_path.read_bytes()
        with mock.patch.object(bridge.subprocess, 'run') as child, mock.patch.object(bridge, 'authorized_adapter') as adapter:
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.execute(self.args(validate_only=True))
        self.assertEqual(error.exception.code, 'VALIDATED_ONLY_NO_DEVICE_EXECUTION')
        self.assertEqual(error.exception.exit_code, 3)
        child.assert_not_called(); adapter.assert_not_called()
        self.assertEqual(self.request_path.read_bytes(), before)
        self.assertFalse(self.result_path.exists()); self.assertEqual(list(self.artifacts.iterdir()), [])

    def test_no_fixed_window_flag_blocks_before_adapter_or_model(self):
        with mock.patch.object(bridge.subprocess, 'run') as child, mock.patch.object(bridge, 'authorized_adapter') as adapter:
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.execute(self.args())
        self.assertEqual(error.exception.code, 'DEVICE_WINDOW_REQUIRED')
        child.assert_not_called(); adapter.assert_not_called()

    def test_authorization_missing_unacknowledged_and_short_windows(self):
        for change in ('missing', 'not-authorized', 'not-acknowledged', 'future', 'short'):
            value = copy.deepcopy(self.request)
            if change == 'missing': value['authorization'] = None
            elif change == 'not-authorized': value['authorization']['authorized'] = False
            elif change == 'not-acknowledged': value['authorization']['sharedDeviceAcknowledged'] = False
            elif change == 'future': value['authorization']['windowStart'] = iso(self.now + timedelta(minutes=1))
            else: value['authorization']['windowEnd'] = iso(self.now + timedelta(seconds=1))
            with self.subTest(change=change), self.assertRaises(bridge.BridgeError):
                bridge.check_window(value, True, self.now)

    def test_expired_deadline_and_unknown_request_fields(self):
        for change in ('expired', 'extra'):
            value = copy.deepcopy(self.request)
            if change == 'expired': value['limits']['deadlineAt'] = iso(self.now - timedelta(seconds=1))
            else: value['unexpected'] = True
            seal(value); self.write_request(value)
            with self.subTest(change=change), self.assertRaises(bridge.BridgeError): self.validate()

    def test_historical_or_any_existing_artifact_prevents_new_result(self):
        (self.artifacts / 'old-preview.png').write_bytes(b'not-model-evidence')
        with self.assertRaises(bridge.BridgeError): self.validate()
        self.assertFalse(self.result_path.exists())

    def test_existing_result_is_not_overwritten(self):
        self.result_path.write_bytes(b'old-result')
        with self.assertRaises(bridge.BridgeError): self.validate()
        self.assertEqual(self.result_path.read_bytes(), b'old-result')

    def test_unsafe_component_paths_are_rejected(self):
        for path in ('../file', '.', 'artifacts\\file', '/absolute', 'C:drive', 'NUL', 'x./file'):
            value = copy.deepcopy(self.request); value['paths']['components'][0]['path'] = path
            seal(value); self.write_request(value)
            with self.subTest(path=path), self.assertRaises(bridge.BridgeError): self.validate()

    def topology(self, same_host=False):
        board = self.root / 'actual-board.lock'; board.write_bytes(b'unit-only actual board lock')
        runtime = self.root / 'runtime.private.json'; runtime.write_bytes(b'{"unitOnly":true}')
        info = board.stat()
        value = {'schemaVersion': 'calculet.sd35-lock-topology/v1', 'approved': True, 'operatorId': 'unit-operator', 'authorizationId': 'unit-window', 'resourceId': 'unit-resource', 'runtimeConfigSha256': bridge.file_sha(runtime), 'controllerHostIdentitySha256': 'a' * 64, 'workerHostIdentitySha256': ('a' if same_host else 'b') * 64, 'controllerLockPath': str(self.lock), 'workerBoardLockPath': str(board), 'lockDomainsReviewedSeparate': True, 'sharedFilesystemAliasesExcluded': True, 'workerBoardLockIdentity': {'device': info.st_dev, 'inode': info.st_ino}}
        path = self.root / 'topology.private.json'; path.write_text(json.dumps(value))
        return {'board_lock': str(board)}, runtime, path, value

    def check_topology(self, same_host=False):
        config, runtime, path, _value = self.topology(same_host)
        return bridge.check_lock_topology(self.request, config, runtime, path, bridge.file_sha(path), local_identity='a' * 64)

    def test_different_host_approved_separation_is_config_binding_only(self):
        result = self.check_topology(False)
        self.assertFalse(result['remote_identity_live_checked'])
        self.assertFalse(result['new_device_execution'])

    def test_same_host_distinct_actual_inodes_can_be_checked_offline_fixture(self):
        self.assertFalse(self.check_topology(True)['new_device_execution'])

    def test_different_strings_without_positive_topology_are_not_proof(self):
        with self.assertRaises(bridge.BridgeError) as error:
            bridge.check_lock_topology(self.request, {'board_lock': str(self.root / 'other-board.lock')}, self.root / 'unused', None, None, local_identity='a' * 64)
        self.assertEqual(error.exception.code, 'LOCK_TOPOLOGY_REQUIRED')

    def test_same_path_is_rejected_and_never_deleted(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.reject_obvious_lock_overlap(str(self.lock), str(self.lock))
        self.assertTrue(self.lock.exists())

    def test_same_inode_alias_is_rejected_without_unlock_or_delete(self):
        alias = self.root / 'alias.lock'
        try: os.link(self.lock, alias)
        except OSError: self.skipTest('Hardlink fixture unavailable')
        with self.assertRaises(bridge.BridgeError):
            bridge.reject_obvious_lock_overlap(str(alias), str(self.lock))
        self.assertTrue(self.lock.exists()); self.assertTrue(alias.exists())

    def test_topology_pin_approval_runtime_and_host_identity_must_match(self):
        config, runtime, path, original = self.topology(True)
        for case in ('pin', 'approval', 'runtime', 'host', 'aliases', 'board-inode'):
            value = copy.deepcopy(original)
            if case == 'approval': value['approved'] = False
            if case == 'runtime': value['runtimeConfigSha256'] = '0' * 64
            if case == 'host': value['controllerHostIdentitySha256'] = 'c' * 64
            if case == 'aliases': value['sharedFilesystemAliasesExcluded'] = False
            if case == 'board-inode': value['workerBoardLockIdentity']['inode'] += 1
            path.write_text(json.dumps(value))
            expected = '0' * 64 if case == 'pin' else bridge.file_sha(path)
            with self.subTest(case=case), self.assertRaises(bridge.BridgeError):
                bridge.check_lock_topology(self.request, config, runtime, path, expected, local_identity='a' * 64)
        self.assertTrue(self.lock.exists())

    def test_private_adapter_pin_is_checked_before_code_import(self):
        home = self.root / 'operator-adapter'; home.mkdir()
        source = b'raise RuntimeError("unit import must not happen")\n'
        (home / 'adapter.py').write_bytes(source)
        (home / 'bundle-manifest.json').write_text(json.dumps({'files': {'adapter.py': {'bytes': len(source), 'sha256': bridge.sha(source)}}}))
        with self.assertRaises(bridge.BridgeError) as error:
            bridge.authorized_adapter(home, '0' * 64)
        self.assertEqual(error.exception.code, 'ADAPTER_IDENTITY_MISMATCH')

    def test_png_format_crc_dimensions_and_bounded_decompression(self):
        valid = png_fixture()
        self.assertEqual(bridge.validate_png(valid), (256, 256))
        corrupted = bytearray(valid); corrupted[30] ^= 1
        for raw in (bytes(corrupted), valid + b'trailing', png_fixture(255), png_fixture(filtering=5), png_fixture(extra_rows=1), b'not-png'):
            with self.subTest(length=len(raw)), self.assertRaises(bridge.BridgeError):
                bridge.validate_png(raw)

    def test_trace_redacts_private_runtime_fields(self):
        trace = bridge.public_trace(self.request, runtime_fixture(png_fixture()))
        raw = bridge.canonical_json(trace)
        self.assertNotIn(b'DO_NOT_EXPOSE_PRIVATE_MARKER', raw)
        self.assertFalse(trace['independentHardwareCertification'])
        self.assertEqual(len(trace['steps']), 4)

    def test_trace_rejects_non_digest_fingerprint(self):
        report = runtime_fixture(png_fixture()); report['npu_calls'][0]['input_sha256'] = 'not-a-fingerprint'
        with self.assertRaises(bridge.BridgeError): bridge.public_trace(self.request, report)

    def test_standard_result_mapping_uses_synthetic_protocol_fixture_only(self):
        private = self.root / 'synthetic-private-fixture'; private.mkdir()
        image = png_fixture(); (private / 'sd35-medium-hybrid.png').write_bytes(image)
        original = self.request_path.read_bytes()
        with mock.patch.object(bridge.subprocess, 'run') as child:
            result = bridge.publish_result(self.request, runtime_fixture(image), private, self.result_path, self.artifacts)
        child.assert_not_called()
        self.assertEqual(result['schemaVersion'], bridge.RESULT_SCHEMA)
        self.assertEqual(set(result), {'schemaVersion', 'requestId', 'jobId', 'requestDigest', 'profileId', 'status', 'executionKind', 'executionMode', 'scope', 'validation', 'artifacts'})
        self.assertEqual(result['validation']['numericValidation'], {'status': 'not_run'})
        self.assertFalse(result['scope']['coreMigrationComplete'])
        index = json.loads((self.artifacts / 'evidence-index.json').read_text())
        self.assertEqual(index['artifacts'], result['artifacts'][:-1])
        for entry in result['artifacts']:
            path = self.job / entry['path']
            self.assertEqual(bridge.file_sha(path), entry['sha256'])
            self.assertEqual(path.stat().st_nlink, 1)
        self.assertEqual(self.request_path.read_bytes(), original)
        self.assertEqual((self.artifacts / 'image.png').read_bytes(), image)

    @unittest.skipUnless(os.environ.get('CALCULET_SERVICE_VALIDATOR_FILE') and shutil.which('node'), 'Optional controlled-service validator not supplied')
    def test_production_validator_accepts_only_a_synthetic_simulation_contract_fixture(self):
        private = self.root / 'simulation-fixture-private'; private.mkdir()
        image = png_fixture(); (private / 'sd35-medium-hybrid.png').write_bytes(image)
        result = bridge.publish_result(self.request, runtime_fixture(image), private, self.result_path, self.artifacts)
        request = copy.deepcopy(self.request)
        request['executionKind'] = 'simulation'; request['authorization'] = None
        request['paths']['controllerLockPath'] = None; seal(request)
        self.write_request(request)
        trace_path = self.artifacts / 'device-trace.json'
        trace = json.loads(trace_path.read_text())
        trace.update(executionKind='simulation', freshInvocation=False, source='synthetic_protocol_fixture', actualHardwareCallCount=0, requestDigest=request['requestDigest'])
        for row in trace['steps']:
            row['simulated'] = True
        trace_path.write_bytes(bridge.canonical_json(trace))
        result.update(executionKind='simulation', requestDigest=request['requestDigest'])
        result['validation']['deviceExecution']['status'] = 'simulated'
        result['artifacts'][1]['sha256'] = bridge.file_sha(trace_path)
        index_path = self.artifacts / 'evidence-index.json'
        index = {'schemaVersion': 'calculet.evidence-index/v1', 'jobId': request['jobId'], 'requestDigest': request['requestDigest'], 'executionKind': 'simulation', 'executionMode': 'hybrid', 'artifacts': result['artifacts'][:-1]}
        index_path.write_bytes(bridge.canonical_json(index))
        result['artifacts'][-1]['sha256'] = bridge.file_sha(index_path)
        self.result_path.write_bytes(bridge.canonical_json(result))
        code = 'import{pathToFileURL}from"node:url";import{readFile,realpath}from"node:fs/promises";const m=await import(pathToFileURL(process.env.CALCULET_SERVICE_VALIDATOR_FILE).href);const q=JSON.parse(await readFile(process.argv[1],"utf8"));const r=JSON.parse(await readFile(process.argv[2],"utf8"));await m.validateResult(r,q,await realpath(process.argv[3]),{maxResultBytes:262144,maxArtifactBytes:33554432});console.log("PASS_SYNTHETIC_SIMULATION_FILE_CONTRACT")'
        checked = subprocess.run(['node', '--input-type=module', '-e', code, str(self.request_path), str(self.result_path), str(self.job)], capture_output=True, text=True, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertIn('PASS_SYNTHETIC_SIMULATION_FILE_CONTRACT', checked.stdout)
        self.assertEqual(result['executionKind'], 'simulation')

    def test_invalid_trace_leaves_no_published_artifact(self):
        private = self.root / 'invalid-trace-fixture'; private.mkdir()
        image = png_fixture(); (private / 'sd35-medium-hybrid.png').write_bytes(image)
        report = runtime_fixture(image)
        report['npu_calls'][0]['input_sha256'] = 'not-a-fingerprint'
        with self.assertRaises(bridge.BridgeError):
            bridge.publish_result(self.request, report, private, self.result_path, self.artifacts)
        self.assertEqual(list(self.artifacts.iterdir()), [])
        self.assertFalse(self.result_path.exists())

    def test_atomic_publication_race_preserves_competing_output(self):
        target = self.job / 'raced-result'
        original_link = os.link
        def competing_writer(source, destination, **kwargs):
            target.write_bytes(b'competing-publication')
            return original_link(source, destination, **kwargs)
        with mock.patch.object(bridge.os, 'link', side_effect=competing_writer):
            with self.assertRaisesRegex(bridge.BridgeError, 'Output appeared'):
                bridge.atomic_bytes(target, b'must-not-overwrite')
        self.assertEqual(target.read_bytes(), b'competing-publication')
        self.assertEqual(list(self.job.glob('.bridge-*.tmp')), [])

    def test_atomic_result_never_replaces_an_existing_file(self):
        target = self.job / 'existing'; target.write_bytes(b'preserve')
        with self.assertRaises(bridge.BridgeError): bridge.atomic_bytes(target, b'replacement')
        self.assertEqual(target.read_bytes(), b'preserve')


if __name__ == '__main__':
    unittest.main()
