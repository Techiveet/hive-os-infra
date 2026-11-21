"""Release admission tests. No real provider or production credentials are used."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('secure_release', Path(__file__).resolve().parents[1] / 'scripts/secure_release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
COMMIT = 'a' * 40
REVISIONS = {'backend': 'b' * 40, 'frontend': 'c' * 40}


def fixture():
    images = {name: 'ghcr.io/techiveet/hive-os-backend@sha256:' + '1' * 64 for name in ('backend', 'queue', 'scheduler', 'reverb')}
    images.update(frontend='ghcr.io/techiveet/hive-os-frontend@sha256:' + '2' * 64,
                  ollama='ghcr.io/techiveet/hive-ollama-cpu@sha256:' + '3' * 64)
    document = {'services': {name: {'image': image, 'pull_policy': 'always', 'platform': 'linux/amd64'} for name, image in images.items()}}
    state = {'uuid': r.APP, 'build_pack': 'dockercompose', 'git_repository': r.REPOSITORY, 'git_branch': 'main', 'base_directory': '/',
             'docker_compose_location': '/' + r.COMPOSE, 'git_commit_sha': 'HEAD', 'additional_servers_count': 0, 'additional_networks_count': 0, 'dockerfile': None, 'docker_compose_raw': json.dumps(document),
             'settings': {'is_auto_deploy_enabled': False, 'is_raw_compose_deployment_enabled': False,
                          'is_build_server_enabled': False, 'is_preview_deployments_enabled': False, 'is_preserve_repository_enabled': True}}
    state.update({key: None for key in r.HOOKS})
    return images, document, state


class FakeProvider:
    def __init__(self):
        self.images, self.document, self.state = fixture()
        self.calls = []
        self.status = 'finished'
        self.commit = COMMIT
        self.receipt_resource = r.APP
        self.version = r.CONTRACT_VERSION
        self.active = []
        self.drift = False
        self.read_count = 0
        self.destinations = [{'uuid': r.DESTINATION, 'server_uuid': r.SERVER, 'is_primary': True}]
        self.server = {'uuid': r.SERVER, 'ip': 'host.docker.internal', 'user': 'root', 'port': 22}

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if path == '/version': return self.version
        if path.endswith('/destinations'): return self.destinations
        if path.startswith('/servers/'): return self.server
        if path == '/deployments': return self.active
        if method == 'PATCH':
            self.state.update(payload)
            if getattr(self, 'active_after_patch', None) is not None:
                self.active = self.active_after_patch
            return {'uuid': r.APP}
        if method == 'POST':
            return {'deployments': [{'resource_uuid': self.receipt_resource, 'deployment_uuid': 'fixture-deployment-1234'}]}
        if path.startswith('/applications/'):
            self.read_count += 1
            state = copy.deepcopy(self.state)
            if self.drift and self.read_count >= 3: state['git_commit_sha'] = 'd' * 40
            return state
        return {'deployment_uuid': 'fixture-deployment-1234', 'commit': self.commit, 'status': self.status}


class ReleaseAdmissionTest(unittest.TestCase):
    def attempt(self, provider, **kwargs):
        return r.deploy(provider, COMMIT, provider.document, provider.images, REVISIONS,
                        scan=lambda images: None, inspect_host=lambda: None, inspect_sources=lambda images, revisions: None,
                        verify=lambda document, images: dict.fromkeys(images, 'actual-container'), **kwargs)

    def test_full_approved_bundle_uses_only_commit_patch_then_unique_receipt(self):
        provider = FakeProvider()
        result = self.attempt(provider)
        self.assertEqual(sorted(r.CORE), result['verified_services'])
        mutations = [x for x in provider.calls if x[0] != 'GET']
        self.assertEqual([('PATCH', '/applications/' + r.APP, {'git_commit_sha': COMMIT}),
                          ('POST', '/deploy?uuid=' + r.APP + '&force=false', None)], mutations)

    def test_compiler_preserves_commands_storage_and_topology(self):
        images, document, _ = fixture()
        document.update(networks={'private': {}}, volumes={'retained': {}})
        document['services']['backend'].update(build={'context': 'old-overlay'}, command=['php', 'artisan', 'octane:start'],
                                               volumes=['retained:/var/www/html/storage'], environment={'APP_KEY': '${APP_KEY:?required}'})
        before = copy.deepcopy(document)
        actual = r.compile_compose(document, images)
        for name, service in actual['services'].items():
            expected = before['services'][name]
            self.assertEqual({k: v for k, v in expected.items() if k not in ('image', 'build', 'pull_policy', 'platform')},
                             {k: v for k, v in service.items() if k not in ('image', 'build', 'pull_policy', 'platform')})
        self.assertEqual(before, document)
        self.assertNotIn('build', actual['services']['backend'])
        self.assertEqual(before['volumes'], actual['volumes'])

    def test_mutable_interpolated_build_or_missing_companion_is_rejected(self):
        for mutation in ('tag', 'variable', 'build', 'extends', 'missing', 'different-worker', 'platform', 'include'):
            with self.subTest(mutation=mutation):
                provider = FakeProvider()
                service = provider.document['services']['queue']
                if mutation == 'tag': service['image'] = 'ghcr.io/techiveet/hive-os-backend:latest'
                if mutation == 'variable': service['image'] = '${HIVE_BACKEND_IMAGE}'
                if mutation == 'build': service['build'] = {}
                if mutation == 'extends': service['extends'] = {'file': 'foreign.yml'}
                if mutation == 'missing': del provider.document['services']['frontend']
                if mutation == 'different-worker':
                    service['image'] = provider.images['queue'] = 'ghcr.io/techiveet/hive-os-backend@sha256:' + '4' * 64
                if mutation == 'platform': service['platform'] = 'linux/arm64'
                if mutation == 'include': provider.document['include'] = ['foreign.yml']
                with self.assertRaises(r.Rejected): self.attempt(provider)
                self.assertFalse(any(x[0] != 'GET' for x in provider.calls))

    def test_unsafe_provider_modes_source_hooks_and_hidden_fields_stop_before_mutation(self):
        mutations = [('git_repository', 'foreign/repo'), ('git_branch', 'mutable'), ('base_directory', '/elsewhere'),
                     ('dockerfile', 'FROM private-unscanned-fixture'), ('uuid', 'another-app'), ('docker_compose_location', '/override.yml'), ('pre_deployment_command', 'private-fixture-do-not-print')]
        for key, value in mutations:
            with self.subTest(key=key):
                provider = FakeProvider(); provider.state[key] = value
                with self.assertRaises(r.Rejected): self.attempt(provider)
                self.assertFalse(any(x[0] != 'GET' for x in provider.calls))
        for mode in ('is_auto_deploy_enabled', 'is_raw_compose_deployment_enabled', 'is_build_server_enabled', 'is_preview_deployments_enabled'):
            provider = FakeProvider(); provider.state['settings'][mode] = True
            with self.assertRaises(r.Rejected): self.attempt(provider)
            self.assertFalse(any(x[0] != 'GET' for x in provider.calls))
        provider = FakeProvider(); del provider.state['pre_deployment_command']
        with self.assertRaises(r.Rejected): self.attempt(provider)

    def test_failed_image_scan_has_no_provider_mutation(self):
        provider = FakeProvider()
        with self.assertRaises(r.Rejected):
            r.deploy(provider, COMMIT, provider.document, provider.images, REVISIONS,
                     inspect_host=lambda: None, scan=lambda images: (_ for _ in ()).throw(r.Rejected('scanner failed')))
        self.assertFalse(any(x[0] != 'GET' for x in provider.calls))

    def test_wrong_version_receipt_commit_failed_status_or_drift_cannot_pass(self):
        for kind in ('version', 'resource', 'commit', 'failed', 'drift', 'raw-definition', 'null-raw-definition'):
            provider = FakeProvider()
            if kind == 'version': provider.version = 'future-version'
            if kind == 'resource': provider.receipt_resource = 'another-app'
            if kind == 'commit': provider.commit = 'f' * 40
            if kind == 'failed': provider.status = 'failed'
            if kind == 'drift': provider.drift = True
            if kind == 'raw-definition': provider.state['docker_compose_raw'] = '{}'
            if kind == 'null-raw-definition': provider.state['docker_compose_raw'] = None
            with self.subTest(kind=kind), self.assertRaises(r.Rejected): self.attempt(provider)
            if kind == 'drift': self.assertFalse(any(x[0] == 'POST' for x in provider.calls))

    def test_busy_queue_and_timeout_do_not_claim_success(self):
        provider = FakeProvider(); provider.active = [{'deployment_uuid': 'other'}]
        with self.assertRaises(r.Rejected): self.attempt(provider)
        self.assertFalse(any(x[0] != 'GET' for x in provider.calls))
        provider = FakeProvider(); provider.status = 'in_progress'
        now = [0]
        with self.assertRaisesRegex(r.Rejected, 'timed out'):
            self.attempt(provider, clock=lambda: now[0], sleep=lambda n: now.__setitem__(0, now[0] + n), timeout=12)

    def test_duplicate_fields_and_unsafe_api_urls_are_rejected(self):
        with self.assertRaises(r.Rejected): r.json_document('{"images":{},"images":{}}')
        for url in ('http://provider.example/api', 'https://user:secret@provider.example/api', 'https://provider.example/api?token=fixture'):
            with self.subTest(url=url), self.assertRaises(r.Rejected): r.Provider(url, 'fixture-token')
        with self.assertRaises(r.Rejected): r.NoRedirect().redirect_request(None, None, None, None, None, None)

    def test_shared_host_lock_refuses_a_second_release(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = str(Path(directory) / 'release.lock')
            with r.release_lock(lock):
                with self.assertRaises(r.Rejected):
                    with r.release_lock(lock): self.fail('second release entered')

    def test_running_image_verification_uses_daemon_data_not_expected_constants(self):
        images, document, _ = fixture()
        containers = []
        for name, image in images.items():
            containers.append({'Id': 'container-' + name, 'Image': 'sha256:actual-' + name,
                               'Config': {'Image': image, 'Labels': {'com.docker.compose.project': r.APP, 'com.docker.compose.service': name}},
                               'State': {'Running': True, 'Health': {'Status': 'healthy'}}})
        def execute(command):
            if command[1:3] == ['ps', '-aq']: return b'container-fixture'
            if command[1] == 'inspect': return json.dumps(containers).encode()
            name = next(name for name, image in images.items() if image == command[-1])
            return json.dumps([{'Id': 'sha256:actual-' + name, 'RepoDigests': [command[-1]]}]).encode()
        # All four PHP services use one actual image identity.
        for container in containers[:4]: container['Image'] = 'sha256:actual-backend'
        self.assertEqual(r.CORE, set(r.verify_runtime(document, images, execute)))
        containers[0]['Image'] = 'sha256:wrong-content'
        with self.assertRaisesRegex(r.Rejected, 'content differs'): r.verify_runtime(document, images, execute)
        containers[0]['Image'] = 'sha256:actual-backend'; containers[0]['Config']['Image'] = 'mutable:latest'
        with self.assertRaises(r.Rejected): r.verify_runtime(document, images, execute)


    def test_core_profiles_missing_platform_and_destination_changes_are_rejected(self):
        for kind in ('profile', 'no-platform', 'destination', 'extra-server', 'connection'):
            provider = FakeProvider()
            if kind == 'profile': provider.document['services']['backend']['profiles'] = ['disabled']
            if kind == 'no-platform': del provider.document['services']['backend']['platform']
            if kind == 'destination': provider.destinations[0]['server_uuid'] = 'another-server'
            if kind == 'extra-server': provider.state['additional_servers_count'] = 1
            if kind == 'connection': provider.server['ip'] = 'another-host'
            with self.subTest(kind=kind), self.assertRaises(r.Rejected): self.attempt(provider)
            self.assertFalse(any(call[0] != 'GET' for call in provider.calls))

    def test_host_identity_architecture_and_legacy_consumer_are_checked(self):
        info = {'ID': r.ENGINE, 'OSType': 'linux', 'Architecture': 'x86_64'}
        unit = 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n'
        def execute(command): return json.dumps(info).encode() if command[0] == 'docker' else unit.encode()
        r.verify_host(execute)
        for key, value in [('ID', 'another-engine'), ('Architecture', 'arm64'), ('OSType', 'windows')]:
            original = info[key]; info[key] = value
            with self.assertRaises(r.Rejected): r.verify_host(execute)
            info[key] = original
        unit = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n'
        with self.assertRaises(r.Rejected): r.verify_host(execute)
        # Shipped hive-autodeploy.service has no [Install] section (inactive/static) once timer is disabled.
        def execute_static(command):
            if command[0] == 'docker': return json.dumps(info).encode()
            if command[2] == 'hive-autodeploy.timer':
                return b'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n'
            return b'LoadState=loaded\nActiveState=inactive\nUnitFileState=static\n'
        r.verify_host(execute_static)

    def test_prepare_cli_stages_a_reviewable_bundle_without_overwriting_source(self):
        images, document, _ = fixture()
        document['services']['backend']['build'] = {'context': 'legacy'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.yml'; source.write_text(json.dumps(document))
            image_map = root / 'images.json'; image_map.write_text(json.dumps(images))
            output = root / 'new-review'
            args = ['--source', str(source), '--images', str(image_map), '--backend-revision', REVISIONS['backend'],
                    '--frontend-revision', REVISIONS['frontend'], '--release-id', 'fixture', '--output', str(output)]
            before = source.read_bytes()
            r.prepare_release(args)
            self.assertEqual(before, source.read_bytes())
            plan = json.loads((output / 'releases/security/fixture.json').read_text())
            contents = (output / r.COMPOSE).read_bytes()
            self.assertEqual(r.hashlib.sha256(contents).hexdigest(), plan['compose_sha256'])
            r.validate_compose(json.loads(contents), plan['images'])
            with self.assertRaises(r.Rejected): r.prepare_release(args)

    def test_git_bundle_uses_committed_bytes_and_rejects_dirty_or_changed_manifest(self):
        images, document, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            raw = (json.dumps(document) + '\n').encode()
            (repo / r.COMPOSE).write_bytes(raw)
            manifest = {'schema': 1, 'application_uuid': r.APP, 'compose_sha256': r.hashlib.sha256(raw).hexdigest(),
                        'images': images, 'source_revisions': REVISIONS}
            target = repo / 'releases/security/fixture.json'; target.parent.mkdir(parents=True); target.write_text(json.dumps(manifest))
            for command in [['git', 'init', '-q'], ['git', 'remote', 'add', 'origin', 'git@github.com:Techiveet/hive-os-infra.git'],
                            ['git', 'add', '.'], ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Disposable fixture']]:
                r.run(command, cwd=repo)
            commit = r.run(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip()
            # Local-only commit without refs/remotes/origin/main must be rejected.
            with self.assertRaises(r.Rejected): r.git_bundle(repo, commit, 'releases/security/fixture.json')
            # Pin trusted remote-tracking main and verify approved commit passes.
            r.run(['git', 'update-ref', 'refs/remotes/origin/main', commit], cwd=repo)
            bundle, actual, ignore = r.git_bundle(repo, commit, 'releases/security/fixture.json')
            self.assertIsNone(ignore)
            self.assertEqual(document, actual); self.assertEqual(images, bundle['images'])
            # A subsequent unreviewed local-only commit ahead of origin/main must be rejected.
            (repo / 'README.local').write_text('unreviewed\n')
            r.run(['git', 'add', 'README.local'], cwd=repo)
            r.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Unreviewed local commit'], cwd=repo)
            local_only = r.run(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip()
            with self.assertRaisesRegex(r.Rejected, 'git fetch origin'): r.git_bundle(repo, local_only, 'releases/security/fixture.json')
            # Approved ancestor commit still passes for rollback.
            bundle2, _, _ = r.git_bundle(repo, commit, 'releases/security/fixture.json')
            self.assertEqual(images, bundle2['images'])
            (repo / r.COMPOSE).write_bytes(raw + b'\n')
            with self.assertRaisesRegex(r.Rejected, 'clean'): r.git_bundle(repo, commit, 'releases/security/fixture.json')
            with self.assertRaises(r.Rejected): r.git_bundle(repo, 'HEAD', 'releases/security/fixture.json')
            with self.assertRaises(r.Rejected): r.git_bundle(repo, commit, '../foreign.json')

    def scan_fixture(self, fail_with=None, failing_image=None):
        commands = []
        def fake_exec(cmd):
            commands.append(cmd)
            if fail_with is not None and '--input' in cmd and any(failing_image in str(c) for c in commands[-3:-1]):
                raise r.CommandFailed('scanner exit', fail_with)
            return b''
        return commands, fake_exec

    def test_scan_images_pulls_once_scans_offline_archives_and_never_passes_credentials(self):
        images = {'backend': 'ghcr.io/techiveet/hive-os-backend@sha256:' + '1' * 64,
                  'queue': 'ghcr.io/techiveet/hive-os-backend@sha256:' + '1' * 64,
                  'db': 'postgres@sha256:' + '2' * 64}
        commands, fake_exec = self.scan_fixture()
        with patch.dict(r.os.environ, {'TRIVY_USERNAME': 'gh-user', 'TRIVY_PASSWORD': 'gh-secret'}):
            self.assertEqual([], r.scan_images(images, execute=fake_exec))
        flat = [' '.join(c) for c in commands]
        self.assertEqual(1, sum('--download-db-only' in c for c in flat), 'vulnerability DB refreshed exactly once')
        pulls = [c for c in commands if c[:2] == ['docker', 'pull']]
        self.assertEqual(sorted(set(images.values())), sorted(c[-1] for c in pulls), 'each unique image pulled exactly once')
        scans = [c for c in commands if '--input' in c]
        self.assertEqual(2, len(scans))
        for cmd in commands:
            joined = ' '.join(cmd)
            self.assertNotIn('gh-secret', joined)
            self.assertNotIn('DOCKER_CONFIG', joined)
        for cmd in scans:
            self.assertIn(r.TRIVY_CACHE_VOLUME + ':' + r.TRIVY_CACHE_DIR, cmd)
            for flag in ('--skip-db-update', '--ignore-unfixed', '--scanners'):
                self.assertIn(flag, cmd)
            self.assertEqual('1', cmd[cmd.index('--exit-code') + 1])
            self.assertNotIn('--ignorefile', cmd)

    def test_scan_images_applies_hash_verified_ignore_file(self):
        commands, fake_exec = self.scan_fixture()
        r.scan_images({'backend': 'ghcr.io/techiveet/hive-os-backend@sha256:' + '1' * 64}, execute=fake_exec, ignore=b'CVE-2099-0001\n')
        scan = next(c for c in commands if '--input' in c)
        self.assertEqual('/scan/.trivyignore', scan[scan.index('--ignorefile') + 1])

    def test_rollback_warns_on_new_findings_but_still_fails_on_scanner_errors(self):
        image = 'ghcr.io/techiveet/hive-os-backend@sha256:' + '1' * 64
        commands, fake_exec = self.scan_fixture(fail_with=r.ROLLBACK_FINDINGS_EXIT, failing_image=image)
        self.assertEqual([image], r.scan_images({'backend': image}, execute=fake_exec, rollback=True))
        scan = next(c for c in commands if '--input' in c)
        self.assertEqual(str(r.ROLLBACK_FINDINGS_EXIT), scan[scan.index('--exit-code') + 1])
        # Normal admission blocks on the very same findings.
        _, fake_exec = self.scan_fixture(fail_with=1, failing_image=image)
        with self.assertRaises(r.Rejected): r.scan_images({'backend': image}, execute=fake_exec)
        # A scanner crash (exit 1) is never downgraded to a warning, even in rollback.
        _, fake_exec = self.scan_fixture(fail_with=1, failing_image=image)
        with self.assertRaises(r.Rejected): r.scan_images({'backend': image}, execute=fake_exec, rollback=True)

    def test_verify_runtime_rejects_restarting_and_unstarted_created_bootstrap_containers(self):
        images, document, _ = fixture()
        images['seaweedfs-bootstrap'] = 'ghcr.io/techiveet/hive-seaweedfs-bootstrap@sha256:' + '4' * 64
        document['services']['seaweedfs-bootstrap'] = {'image': images['seaweedfs-bootstrap'], 'pull_policy': 'always', 'platform': 'linux/amd64'}
        def make_containers(restarting=False, bootstrap_status='exited'):
            containers = []
            for name, image in images.items():
                if name == 'seaweedfs-bootstrap':
                    state = {'Running': False, 'Status': bootstrap_status, 'ExitCode': 0}
                else:
                    state = {'Running': True, 'Restarting': restarting, 'Paused': False}
                containers.append({'Id': 'c-' + name, 'Image': 'sha256:actual-' + name,
                                   'Config': {'Image': image, 'Labels': {'com.docker.compose.project': r.APP, 'com.docker.compose.service': name}},
                                   'State': state})
            for c in containers[:4]: c['Image'] = 'sha256:actual-backend'
            return containers
        def run_with(containers):
            def execute(cmd):
                if cmd[1:3] == ['ps', '-aq']: return b'c-fixture'
                if cmd[1] == 'inspect': return json.dumps(containers).encode()
                name = next(n for n, img in images.items() if img == cmd[-1])
                img_id = 'sha256:actual-backend' if name in ('backend', 'queue', 'scheduler', 'reverb') else 'sha256:actual-' + name
                return json.dumps([{'Id': img_id, 'RepoDigests': [cmd[-1]]}]).encode()
            return r.verify_runtime(document, images, execute)
        self.assertIn('seaweedfs-bootstrap', run_with(make_containers(restarting=False, bootstrap_status='exited')))
        with self.assertRaises(r.NotReady): run_with(make_containers(restarting=True, bootstrap_status='exited'))
        with self.assertRaises(r.NotReady): run_with(make_containers(restarting=False, bootstrap_status='created'))

    def test_preparation_handles_actual_vps_topology_without_changing_source(self):
        import yaml
        source = Path(__file__).resolve().parents[1] / r.COMPOSE
        before = source.read_bytes(); definition = yaml.safe_load(before)
        core_images, _, _ = fixture()
        images = {name: 'ghcr.io/techiveet/security-fixture/' + name + '@sha256:' + r.hashlib.sha256(name.encode()).hexdigest()
                  for name in definition['services']}
        images.update(core_images)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image_map = root / 'images.json'; image_map.write_text(json.dumps(images)); output = root / 'review'
            r.prepare_release(['--source', str(source), '--images', str(image_map), '--backend-revision', REVISIONS['backend'],
                               '--frontend-revision', REVISIONS['frontend'], '--release-id', 'topology-fixture', '--output', str(output)])
            actual = json.loads((output / r.COMPOSE).read_text())
            self.assertEqual(set(definition['services']), set(actual['services']))
            for name, service in definition['services'].items():
                self.assertEqual({k: v for k, v in service.items() if k not in ('image', 'build', 'pull_policy', 'platform')},
                                 {k: v for k, v in actual['services'][name].items() if k not in ('image', 'build', 'pull_policy', 'platform')})
        self.assertEqual(before, source.read_bytes())

    def test_legacy_entrypoints_reject_without_bundle_before_running_old_commands(self):
        for name in ('auto-deploy.sh', 'deploy-prod.sh'):
            script = Path(__file__).resolve().parents[1] / 'scripts' / name
            result = r.subprocess.run(['bash', str(script)], env={'PATH': r.os.environ['PATH']}, capture_output=True)
            self.assertEqual(2, result.returncode)
            self.assertIn(b'HIVE_RELEASE_COMMIT and HIVE_RELEASE_MANIFEST are required', result.stderr)
        deploy_script = Path(__file__).resolve().parents[1] / 'scripts' / 'deploy-prod.sh'
        legacy_args = r.subprocess.run(
            ['bash', str(deploy_script), '--root-domain', 'example.com', '--server-ip', '1.2.3.4'],
            env={'PATH': r.os.environ['PATH'], 'HIVE_RELEASE_COMMIT': COMMIT, 'HIVE_RELEASE_MANIFEST': 'releases/security/fixture.json'},
            capture_output=True,
        )
        self.assertEqual(2, legacy_args.returncode)
        self.assertIn(b'legacy arguments', legacy_args.stderr)

    def test_provider_errors_withhold_credentials_and_private_bodies(self):
        import io
        provider = r.Provider('https://provider.example/api/v1', 'private-fixture-token')
        class BrokenOpener:
            def open(self, request, timeout):
                raise r.urllib.error.HTTPError(request.full_url, 500, 'private-fixture-reason', {}, io.BytesIO(b'private-fixture-response'))
        provider.opener = BrokenOpener()
        with self.assertRaises(r.Rejected) as error: provider.request('GET', '/applications/' + r.APP)
        self.assertNotIn('private-fixture', str(error.exception))

    def test_command_failures_name_the_command_and_image_without_secrets(self):
        image = 'ghcr.io/techiveet/hive-os-backend@sha256:' + '1' * 64
        with self.assertRaises(r.CommandFailed) as caught:
            r.run(['bash', '-c', 'exit 7', 'TOKEN=private-fixture-secret', image])
        message = str(caught.exception)
        self.assertEqual(7, caught.exception.returncode)
        self.assertIn('exit 7', message)
        self.assertIn('bash -c', message)
        self.assertIn(image, message)
        self.assertNotIn('private-fixture-secret', message)

    def test_malformed_provider_payloads_are_rejected_not_crashing(self):
        provider = FakeProvider(); provider.destinations = ['not-a-dict']
        with self.assertRaises(r.Rejected): self.attempt(provider)
        real = r.Provider('https://provider.example/api/v1', 'fixture-token')
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *exc): return False
            def read(self, limit): return self.body
        class Opener:
            body = b'\xff\xfe4.5.3'
            def open(self, request, timeout): return Response(self.body)
        real.opener = Opener()
        with self.assertRaisesRegex(r.Rejected, 'UTF-8'): real.request('GET', '/version')
        Opener.body = b'[1, 2'
        with self.assertRaisesRegex(r.Rejected, 'Invalid JSON'): real.request('GET', '/applications/x')

    def test_unexpected_errors_exit_nonzero_without_leaking_details(self):
        import contextlib, io
        def explode(): raise KeyError('private-fixture-provider-body')
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as caught:
            r.entrypoint(explode)
        self.assertEqual(1, caught.exception.code)
        self.assertIn('unexpected internal error (KeyError)', stderr.getvalue())
        self.assertNotIn('private-fixture', stderr.getvalue())

    def test_failed_pre_receipt_admission_restores_the_previous_provider_commit(self):
        provider = FakeProvider(); provider.active_after_patch = [{'deployment_uuid': 'raced-in'}]
        with self.assertRaisesRegex(r.Rejected, 'previous provider commit restored'): self.attempt(provider)
        mutations = [x for x in provider.calls if x[0] != 'GET']
        self.assertEqual([('PATCH', '/applications/' + r.APP, {'git_commit_sha': COMMIT}),
                          ('PATCH', '/applications/' + r.APP, {'git_commit_sha': 'HEAD'})], mutations)
        self.assertEqual('HEAD', provider.state['git_commit_sha'])

    def test_runtime_wait_covers_the_compose_healthcheck_budget(self):
        provider = FakeProvider()
        provider.document['services']['backend']['healthcheck'] = {'start_period': '600s', 'interval': '30s', 'timeout': '10s', 'retries': 3}
        provider.state['docker_compose_raw'] = json.dumps(provider.document)
        self.assertEqual(720, r.healthcheck_budget(provider.document))
        self.assertEqual(90, r.duration_seconds('1m30s', 0))
        now = [0]
        def verify(document, images):
            if now[0] < 650: raise r.NotReady('backend still starting')
            return dict.fromkeys(images, 'actual-container')
        result = r.deploy(provider, COMMIT, provider.document, provider.images, REVISIONS,
                          scan=lambda images: None, inspect_host=lambda: None, inspect_sources=lambda images, revisions: None,
                          verify=verify, clock=lambda: now[0], sleep=lambda n: now.__setitem__(0, now[0] + n))
        self.assertEqual(sorted(r.CORE), result['verified_services'])
        self.assertGreaterEqual(r.DEFAULT_RUNTIME_TIMEOUT, 660)

    def test_infra_images_must_carry_infra_source_labels(self):
        images, _, _ = fixture()
        images['caddy'] = 'ghcr.io/techiveet/hive-caddy@sha256:' + '5' * 64
        labels = {images['backend']: {'org.opencontainers.image.revision': REVISIONS['backend'], 'org.opencontainers.image.source': 'https://github.com/Techiveet/hive-os-backend'},
                  images['ollama']: {'org.opencontainers.image.revision': REVISIONS['backend'], 'org.opencontainers.image.source': 'https://github.com/Techiveet/hive-os-backend'},
                  images['frontend']: {'org.opencontainers.image.revision': REVISIONS['frontend'], 'org.opencontainers.image.source': 'https://github.com/Techiveet/hive-os-frontend'},
                  images['caddy']: {'org.opencontainers.image.revision': 'e' * 40, 'org.opencontainers.image.source': 'https://github.com/Techiveet/hive-os-infra'}}
        def execute(command): return json.dumps([{'Id': 'sha256:x', 'Config': {'Labels': labels[command[-1]]}}]).encode()
        r.verify_sources(images, REVISIONS, execute)
        labels[images['caddy']]['org.opencontainers.image.source'] = 'https://github.com/someone/else'
        with self.assertRaisesRegex(r.Rejected, 'caddy'): r.verify_sources(images, REVISIONS, execute)
        labels[images['caddy']] = {}
        with self.assertRaisesRegex(r.Rejected, 'caddy'): r.verify_sources(images, REVISIONS, execute)

    def test_yaml_merge_keys_are_accepted_but_real_duplicates_are_not(self):
        merged = r.load_unique_yaml(b"x-base: &base\n  restart: always\n  image: old\nservices:\n  web:\n    <<: *base\n    image: new\n")
        self.assertEqual({'restart': 'always', 'image': 'new'}, merged['services']['web'])
        with self.assertRaises(r.Rejected): r.load_unique_yaml(b"services:\n  web:\n    image: a\n    image: b\n")

    def test_git_bundle_verifies_optional_trivyignore_hash(self):
        images, document, _ = fixture()
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            raw = (json.dumps(document) + '\n').encode()
            (repo / r.COMPOSE).write_bytes(raw)
            ignore = b'CVE-2099-0001\n'
            manifest = {'schema': 1, 'application_uuid': r.APP, 'compose_sha256': r.hashlib.sha256(raw).hexdigest(), 'images': images,
                        'source_revisions': REVISIONS, 'trivyignore': {'path': 'releases/security/fixture.trivyignore', 'sha256': r.hashlib.sha256(ignore).hexdigest()}}
            (repo / 'releases/security').mkdir(parents=True)
            (repo / 'releases/security/fixture.json').write_text(json.dumps(manifest))
            (repo / 'releases/security/fixture.trivyignore').write_bytes(ignore)
            tampered = dict(manifest, trivyignore=dict(manifest['trivyignore'], sha256='0' * 64))
            (repo / 'releases/security/tampered.json').write_text(json.dumps(tampered))
            for command in [['git', 'init', '-q'], ['git', 'remote', 'add', 'origin', 'git@github.com:Techiveet/hive-os-infra.git'],
                            ['git', 'add', '.'], ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Disposable fixture']]:
                r.run(command, cwd=repo)
            commit = r.run(['git', 'rev-parse', 'HEAD'], cwd=repo).decode().strip()
            r.run(['git', 'update-ref', 'refs/remotes/origin/main', commit], cwd=repo)
            _, _, loaded = r.git_bundle(repo, commit, 'releases/security/fixture.json')
            self.assertEqual(ignore, loaded)
            with self.assertRaisesRegex(r.Rejected, 'trivyignore bytes differ'): r.git_bundle(repo, commit, 'releases/security/tampered.json')

    def test_entrypoints_explain_the_cutover_when_no_manifest_is_admitted(self):
        repo = Path(__file__).resolve().parents[1]
        has_manifest = any((repo / 'releases/security').glob('*.json')) if (repo / 'releases/security').is_dir() else False
        for name in ('auto-deploy.sh', 'deploy-prod.sh'):
            result = r.subprocess.run(['bash', str(repo / 'scripts' / name)], env={'PATH': r.os.environ['PATH']}, capture_output=True)
            self.assertEqual(2, result.returncode)
            self.assertEqual(not has_manifest, b'Cutover pending' in result.stderr)


if __name__ == '__main__': unittest.main()