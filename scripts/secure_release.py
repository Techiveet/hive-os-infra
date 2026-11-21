#!/usr/bin/env python3
"""Coordinated Hive release admission. Run on the Docker host, from reviewed infra Git.

No deployment occurs without --apply. No credentials or provider response bodies
are printed. JSON is used for the committed Compose document (valid YAML 1.2).
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

APP = 'z140ve7ehjoyuoluqk0azmwe'
REPOSITORY = 'Techiveet/hive-os-infra'
DESTINATION = 'vcfbioyx3vsfmojgjxzc2gnx'
SERVER = 'qvbw4wgm9w42i3iepakd9rfc'
ENGINE = '8d21ace1-8483-45b4-9a7a-ced5ff190094'
COMPOSE = 'docker-compose.prod.vps.yml'
CONTRACT_VERSION = '4.5.3'
SCANNER = 'aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c'
TRIVY_CACHE_VOLUME = 'hive-trivy-cache'
TRIVY_CACHE_DIR = '/root/.cache/trivy'
# Trivy exits with this code when (and only when) HIGH/CRITICAL findings remain
# in rollback mode, so findings can be told apart from scanner failures (1).
ROLLBACK_FINDINGS_EXIT = 3
DEFAULT_RUNTIME_TIMEOUT = 660
SHA = re.compile(r'[0-9a-f]{40}\Z')
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
DIGEST = re.compile(r'[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}\Z')
MANIFEST_PATH = re.compile(r'releases/security/[a-z0-9][a-z0-9_-]{0,63}\.json\Z')
TRIVYIGNORE_PATH = re.compile(r'releases/security/[a-z0-9][a-z0-9_-]{0,63}\.trivyignore\Z')
CORE = {'backend', 'queue', 'scheduler', 'reverb', 'frontend', 'ollama'}
INFRA_IMAGES = ('ffmpeg', 'video-backend', 'seaweedfs-bootstrap', 'caddy')
HOOKS = ('pre_deployment_command', 'post_deployment_command',
         'docker_compose_custom_start_command', 'docker_compose_custom_build_command')
REQUIRED_MANIFEST_FIELDS = {'schema', 'application_uuid', 'compose_sha256', 'images', 'source_revisions'}
OPTIONAL_MANIFEST_FIELDS = {'trivyignore'}


class Rejected(RuntimeError):
    pass

class NotReady(Rejected):
    pass

class CommandFailed(Rejected):
    def __init__(self, message, returncode):
        super().__init__(message)
        self.returncode = returncode


def require(condition, message):
    if not condition:
        raise Rejected(message)


def json_document(data):
    require(len(data) <= 5 * 1024 * 1024, 'Document exceeds size limit')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON field')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique)
    except (ValueError, TypeError):  # UnicodeDecodeError is a ValueError
        raise Rejected('Invalid JSON document') from None


def strict_text(data, what):
    try:
        return data.decode('utf-8', errors='strict')
    except (UnicodeDecodeError, AttributeError):
        raise Rejected(what + ' is not valid UTF-8') from None


def command_context(args):
    """Non-secret description of a command: the program + subcommand and any
    immutable image reference. Never includes env values, paths or tokens."""
    head = ' '.join(str(arg) for arg in list(args)[:2])
    images = [str(arg) for arg in args if isinstance(arg, str) and DIGEST.fullmatch(arg)]
    return head + (' ' + images[-1] if images else '')


def run(args, *, cwd=None, env=None):
    try:
        process = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=1800)
    except (OSError, subprocess.TimeoutExpired):
        raise Rejected('Required command unavailable or timed out: ' + command_context(args)) from None
    if process.returncode != 0:
        raise CommandFailed('Required command failed (exit %d): %s; no provider/body/log output emitted'
                            % (process.returncode, command_context(args)), process.returncode)
    return process.stdout


def compile_compose(source, images):
    """Replace only image/build/pull choices. Retain commands, mounts and topology."""
    document = copy.deepcopy(source)
    require(isinstance(document, dict) and isinstance(images, dict), 'Invalid compile input')
    services = document.get('services')
    require(isinstance(services, dict) and set(services) == set(images), 'Incomplete service image map')
    for name, service in services.items():
        require(isinstance(service, dict), 'Invalid service')
        service['image'] = images[name]
        service.pop('build', None)
        service['pull_policy'] = 'always'
        require(service.get('platform', 'linux/amd64') == 'linux/amd64', 'Source platform requires separate review')
        service['platform'] = 'linux/amd64'
    validate_compose(document, images)
    return document


def validate_compose(document, images):
    require(isinstance(document, dict) and isinstance(images, dict), 'Invalid release documents')
    require(not any(key in document for key in ('include', 'extends')), 'External Compose definitions are forbidden')
    services = document.get('services')
    require(isinstance(services, dict) and set(services) == set(images) and CORE <= set(services), 'Incomplete release bundle')
    for name, service in services.items():
        require(isinstance(name, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]*', name), 'Invalid service name')
        require(isinstance(service, dict), 'Invalid service definition')
        require(not any(key in service for key in ('build', 'extends', 'develop', 'provider')), 'Release cannot build or replace services')
        image = service.get('image')
        require(isinstance(image, str) and DIGEST.fullmatch(image), 'Every image must have an immutable digest')
        require(image == images[name], 'Effective image differs from bundle')
        require(service.get('pull_policy') == 'always', 'Release must pull exact image references')
        require(service.get('platform') == 'linux/amd64', 'Unsupported image platform')
        require(isinstance(service.get('profiles', []), list), 'Invalid service profiles')
    require(all(not services[name].get('profiles') for name in CORE), 'Core application services cannot be optional profiles')
    backend = images['backend']
    require(backend.startswith('ghcr.io/techiveet/hive-os-backend@'), 'Wrong PHP image repository')
    require(all(images[name] == backend for name in ('queue', 'scheduler', 'reverb')), 'PHP services must share one image')
    require(images['frontend'].startswith('ghcr.io/techiveet/hive-os-frontend@'), 'Wrong frontend image repository')
    require(images['ollama'].startswith('ghcr.io/techiveet/hive-ollama-cpu@'), 'Wrong Ollama image repository')
    return services


def git_bundle(repo, commit, manifest, *, approved_ref='refs/remotes/origin/main'):
    """Load an admitted release bundle from reviewed Git.

    Returns (bundle, compose_document, trivyignore_bytes_or_None).
    """
    require(SHA.fullmatch(commit), 'Infra commit must be a full Git SHA')
    require(MANIFEST_PATH.fullmatch(manifest), 'Invalid release manifest path')
    remote = run(['git', 'remote', 'get-url', 'origin'], cwd=repo).decode().strip()
    require(remote in ('git@github.com:Techiveet/hive-os-infra.git', 'https://github.com/Techiveet/hive-os-infra.git'), 'Wrong infra repository')
    require(not run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=repo).strip(), 'Tracked infra worktree must be clean')
    # Verify ancestry against the trusted remote-tracking protected main branch (never unreviewed local HEAD).
    try:
        run(['git', 'rev-parse', '--verify', '--quiet', approved_ref + '^{commit}'], cwd=repo)
        run(['git', 'merge-base', '--is-ancestor', commit, approved_ref], cwd=repo)
    except Rejected:
        raise Rejected('Commit is not reachable from ' + approved_ref + ' (or that ref is missing/stale); '
                       'run `git fetch origin` on the host and retry with a reviewed main commit') from None
    raw = run(['git', 'show', f'{commit}:{manifest}'], cwd=repo)
    bundle = json_document(raw)
    require(isinstance(bundle, dict) and bundle.get('schema') == 1 and bundle.get('application_uuid') == APP, 'Wrong release contract or application')
    require(REQUIRED_MANIFEST_FIELDS <= set(bundle) <= REQUIRED_MANIFEST_FIELDS | OPTIONAL_MANIFEST_FIELDS, 'Unexpected release fields')
    require(isinstance(bundle['images'], dict), 'Invalid release image map')
    require(isinstance(bundle['source_revisions'], dict) and set(bundle['source_revisions']) == {'backend', 'frontend'}, 'Missing source revisions')
    require(all(isinstance(v, str) and SHA.fullmatch(v) for v in bundle['source_revisions'].values()), 'Sources must be immutable commits')
    raw_compose = run(['git', 'show', f'{commit}:{COMPOSE}'], cwd=repo)
    require(hashlib.sha256(raw_compose).hexdigest() == bundle['compose_sha256'], 'Compose bytes differ from release')
    document = json_document(raw_compose)
    validate_compose(document, bundle['images'])
    ignore = None
    if 'trivyignore' in bundle:
        entry = bundle['trivyignore']
        require(isinstance(entry, dict) and set(entry) == {'path', 'sha256'}, 'Invalid trivyignore reference')
        require(isinstance(entry['path'], str) and TRIVYIGNORE_PATH.fullmatch(entry['path']), 'Invalid trivyignore path')
        require(isinstance(entry['sha256'], str) and SHA256.fullmatch(entry['sha256']), 'Invalid trivyignore hash')
        ignore = run(['git', 'show', f'{commit}:{entry["path"]}'], cwd=repo)
        require(len(ignore) <= 256 * 1024, 'trivyignore exceeds size limit')
        require(hashlib.sha256(ignore).hexdigest() == entry['sha256'], 'trivyignore bytes differ from release')
        strict_text(ignore, 'trivyignore')
    return bundle, document, ignore


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Rejected('Provider redirect refused')


class Provider:
    def __init__(self, base, token):
        parsed = urllib.parse.urlsplit(base)
        require(parsed.scheme == 'https' and parsed.netloc and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, 'Provider must be an HTTPS API URL')
        require(bool(token) and '\n' not in token and '\r' not in token, 'Missing or invalid private provider token')
        self.base, self.token = base.rstrip('/'), token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.base + path, data=body, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json', 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                data = response.read(5 * 1024 * 1024 + 1)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
            raise Rejected('Provider request failed; response body withheld; do not blindly retry a deployment trigger') from None
        if path == '/version':
            require(len(data) <= 256, 'Provider version response too large')
            return strict_text(data, 'Provider version').strip('"\n\r ')
        return json_document(data)


def application(provider, commit=None):
    state = provider.request('GET', '/applications/' + APP)
    require(isinstance(state, dict), 'Missing provider application')
    expected = {'uuid': APP, 'build_pack': 'dockercompose', 'git_repository': REPOSITORY,
                'git_branch': 'main', 'base_directory': '/', 'docker_compose_location': '/' + COMPOSE}
    for key, value in expected.items():
        require(state.get(key) == value, 'Provider source or application identity mismatch')
    require('dockerfile' in state and state['dockerfile'] in (None, ''), 'Inline Dockerfile overrides the Compose build pack')
    require(state.get('additional_servers_count') == 0 and state.get('additional_networks_count') == 0, 'Additional destinations are not verified')
    destinations = provider.request('GET', '/applications/' + APP + '/destinations')
    require(isinstance(destinations, list) and len(destinations) == 1 and isinstance(destinations[0], dict), 'Provider destination changed')
    require(destinations[0].get('uuid') == DESTINATION and destinations[0].get('server_uuid') == SERVER and destinations[0].get('is_primary') is True, 'Provider destination changed')
    server = provider.request('GET', '/servers/' + SERVER)
    require(isinstance(server, dict) and server.get('uuid') == SERVER and server.get('ip') == 'host.docker.internal' and server.get('user') == 'root' and server.get('port') == 22, 'Provider server connection changed')
    settings = state.get('settings', {})
    require(isinstance(settings, dict), 'Missing provider settings')
    for key in ('is_auto_deploy_enabled', 'is_raw_compose_deployment_enabled', 'is_build_server_enabled', 'is_preview_deployments_enabled'):
        require(settings.get(key) is False, 'Independent deployments/raw/build-server/preview mode must be disabled')
    require(settings.get('is_preserve_repository_enabled') is True, 'Existing repository and file layout must be preserved')
    for key in HOOKS:
        require(key in state and state[key] in (None, ''), 'Opaque provider command cannot be verified; sensitive configuration read required')
    if commit is not None:
        require(state.get('git_commit_sha') == commit, 'Provider commit changed or was not pinned')
    return state


def trivy_command(*extra, mounts=()):
    command = ['docker', 'run', '--rm', '--platform', 'linux/amd64', '-v', f'{TRIVY_CACHE_VOLUME}:{TRIVY_CACHE_DIR}']
    for mount in mounts:
        command += ['-v', mount]
    return command + [SCANNER, *extra]


def scan_images(images, execute=run, *, ignore=None, rollback=False):
    """Pull every image once, then scan that exact local copy offline.

    Images are pulled with the host's own registry credentials and exported
    with `docker save`, so the scanner never receives registry credentials and
    nothing is downloaded twice. The vulnerability DB is fetched once into a
    persistent named volume and every per-image scan runs with
    --skip-db-update. Unfixed findings are ignored (nothing to upgrade to);
    an optional hash-verified .trivyignore from the admitted manifest applies.

    In rollback mode HIGH/CRITICAL findings published after the bundle was
    admitted are reported as warnings instead of blocking, while scanner or
    pull failures still reject. Returns the list of images with warnings.
    """
    warnings = []
    # One DB refresh per release (vulnerability + Java DBs) into the persistent
    # cache volume; every per-image scan below then runs fully offline.
    execute(trivy_command('image', '--download-db-only', '--no-progress', '--cache-dir', TRIVY_CACHE_DIR))
    execute(trivy_command('image', '--download-java-db-only', '--no-progress', '--cache-dir', TRIVY_CACHE_DIR))
    with tempfile.TemporaryDirectory(prefix='hive-trivy-scan-', dir=os.environ.get('HIVE_SCAN_TMPDIR') or None) as scan_dir:
        os.chmod(scan_dir, 0o700)
        flags = ['--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--skip-db-update', '--skip-java-db-update',
                 '--cache-dir', TRIVY_CACHE_DIR, '--no-progress',
                 '--exit-code', str(ROLLBACK_FINDINGS_EXIT if rollback else 1)]
        if ignore is not None:
            (Path(scan_dir) / '.trivyignore').write_bytes(ignore)
            flags += ['--ignorefile', '/scan/.trivyignore']
        for image in sorted(set(images.values())):
            execute(['docker', 'pull', '--platform', 'linux/amd64', image])
            archive = Path(scan_dir) / 'image.tar'
            execute(['docker', 'save', '--output', str(archive), image])
            try:
                execute(trivy_command('image', *flags, '--input', '/scan/image.tar', mounts=(f'{scan_dir}:/scan:ro',)))
            except CommandFailed as failure:
                if not (rollback and failure.returncode == ROLLBACK_FINDINGS_EXIT):
                    raise
                warnings.append(image)
                print('Rollback warning: ' + image + ' now has HIGH/CRITICAL findings published after admission; '
                      'redeploying the previously admitted digest anyway', file=sys.stderr)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    archive.unlink()
    return warnings


def verify_runtime(document, images, execute=run):
    services = validate_compose(document, images)
    ids = execute(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + APP]).decode().split()
    if not ids:
        raise NotReady('No containers belong to this application')
    containers = json_document(execute(['docker', 'inspect', *ids]))
    require(isinstance(containers, list), 'Invalid container inspection')
    running = {}
    for container in containers:
        require(isinstance(container, dict) and isinstance(container.get('Config', {}), dict), 'Invalid container inspection')
        labels = container.get('Config', {}).get('Labels', {}) or {}
        require(isinstance(labels, dict), 'Invalid container labels')
        require(labels.get('com.docker.compose.project') == APP, 'Foreign project container')
        name = labels.get('com.docker.compose.service')
        state = container.get('State', {})
        require(isinstance(state, dict), 'Invalid container state')
        is_completed_bootstrap = (
            name == 'seaweedfs-bootstrap'
            and state.get('Status') == 'exited'
            and state.get('ExitCode') == 0
        )
        if not state.get('Running') and not is_completed_bootstrap:
            continue
        if state.get('Restarting') or state.get('Paused'):
            raise NotReady('Service is restarting or paused')
        require(name in images, 'Unexpected live service')
        require(name not in running, 'Multiple live containers for one service')
        require(container['Config'].get('Image') == images[name], 'Container uses another image reference')
        verify_image_identity(container, images[name], execute)
        health = state.get('Health', {})
        require(isinstance(health, dict), 'Invalid container health')
        if health.get('Status', 'healthy') != 'healthy':
            raise NotReady('Service is unhealthy or still starting')
        running[name] = container['Id']
    required = CORE | {name for name, service in services.items() if not service.get('profiles')}
    if not required <= set(running):
        raise NotReady('Required release services are missing')
    return running


def inspect_image(reference, execute=run):
    actual = json_document(execute(['docker', 'image', 'inspect', reference]))
    require(isinstance(actual, list) and len(actual) == 1 and isinstance(actual[0], dict), 'Invalid image inspection')
    return actual[0]


def verify_image_identity(container, reference, execute=run):
    require(isinstance(reference, str) and DIGEST.fullmatch(reference), 'Immutable image reference required')
    require(container.get('Config', {}).get('Image') == reference, 'Container uses another image reference')
    actual = inspect_image(reference, execute)
    require(container.get('Image') == actual.get('Id'), 'Running image content differs from the pulled digest')
    require(reference in (actual.get('RepoDigests') or []), 'Local image has no matching repository digest')


def image_labels(reference, execute=run):
    config = inspect_image(reference, execute).get('Config') or {}
    require(isinstance(config, dict), 'Invalid image configuration')
    labels = config.get('Labels') or {}
    require(isinstance(labels, dict), 'Invalid image labels')
    return labels


def verify_sources(images, revisions, execute=run):
    require(isinstance(revisions, dict) and set(revisions) == {'backend', 'frontend'}, 'Missing source revisions')
    require(all(isinstance(value, str) and SHA.fullmatch(value) for value in revisions.values()), 'Invalid source revision')
    for name, source in [('backend', 'backend'), ('frontend', 'frontend'), ('ollama', 'backend')]:
        labels = image_labels(images[name], execute)
        require(labels.get('org.opencontainers.image.revision') == revisions[source], 'Image source revision mismatch')
        require(labels.get('org.opencontainers.image.source') == 'https://github.com/Techiveet/hive-os-' + source, 'Image source repository mismatch')
    # Infra-built companions (publish-images.yml) must carry infra provenance too.
    for name, reference in sorted(images.items()):
        repository = reference.split('@', 1)[0]
        if repository not in {'ghcr.io/techiveet/hive-' + infra for infra in INFRA_IMAGES}:
            continue
        labels = image_labels(reference, execute)
        revision = labels.get('org.opencontainers.image.revision')
        require(isinstance(revision, str) and SHA.fullmatch(revision), 'Infra image ' + name + ' has no immutable source revision')
        require(labels.get('org.opencontainers.image.source') == 'https://github.com/' + REPOSITORY, 'Infra image ' + name + ' source repository mismatch')


def verify_host(execute=run):
    info = json_document(execute(['docker', 'info', '--format', '{{json .}}']))
    require(isinstance(info, dict), 'Invalid Docker daemon information')
    require(info.get('ID') == ENGINE and info.get('OSType') == 'linux' and info.get('Architecture') in ('amd64', 'x86_64'), 'Consumer Docker daemon is not the verified production destination')
    for unit in ('hive-autodeploy.timer', 'hive-autodeploy.service'):
        data = strict_text(execute(['systemctl', 'show', unit, '--property=LoadState,ActiveState,UnitFileState']), 'systemctl output')
        fields = dict(line.split('=', 1) for line in data.splitlines() if '=' in line)
        allowed_states = ('disabled', 'masked') if unit.endswith('.timer') else ('disabled', 'masked', 'static')
        require(fields.get('LoadState') == 'not-found' or (fields.get('ActiveState') == 'inactive' and fields.get('UnitFileState') in allowed_states), 'Legacy automatic release consumer is not disabled')


DURATION = re.compile(r'(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?\Z')


def duration_seconds(value, default):
    """Compose duration ('1m30s', '600s', '10m') or bare seconds -> seconds."""
    if value is None:
        return default
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    match = DURATION.fullmatch(str(value).strip()) if str(value).strip() else None
    if not match:
        return default
    hours, minutes, seconds, millis = (int(part or 0) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def healthcheck_budget(document):
    """Longest time any service may legitimately take to report healthy:
    start_period + (interval + timeout) * retries, using Docker's defaults."""
    budget = 0.0
    services = document.get('services', {}) if isinstance(document, dict) else {}
    for service in services.values():
        check = service.get('healthcheck') if isinstance(service, dict) else None
        if not isinstance(check, dict) or check.get('disable') is True:
            continue
        retries = check.get('retries', 3)
        retries = retries if isinstance(retries, int) and not isinstance(retries, bool) and retries > 0 else 3
        interval = duration_seconds(check.get('interval'), 30)
        timeout = duration_seconds(check.get('timeout'), 30)
        start = duration_seconds(check.get('start_period'), 0)
        budget = max(budget, start + (interval + timeout) * retries)
    return budget


def restore_commit(provider, previous):
    if not (isinstance(previous, str) and previous):
        return 'previous provider commit unknown; nothing restored; inspect the provider before retrying'
    try:
        provider.request('PATCH', '/applications/' + APP, {'git_commit_sha': previous})
        state = provider.request('GET', '/applications/' + APP)
        if isinstance(state, dict) and state.get('git_commit_sha') == previous:
            return 'previous provider commit restored'
    except Rejected:
        pass
    return 'restoring the previous provider commit FAILED; inspect the provider before retrying'


def deploy(provider, commit, document, images, revisions, *, scan=scan_images, inspect_host=verify_host, inspect_sources=verify_sources, verify=verify_runtime,
           clock=time.monotonic, sleep=time.sleep, timeout=1200, runtime_timeout=DEFAULT_RUNTIME_TIMEOUT):
    require(isinstance(commit, str) and SHA.fullmatch(commit), 'Infra commit must be immutable')
    validate_compose(document, images)
    inspect_host()
    require(provider.request('GET', '/version') == CONTRACT_VERSION, 'Unverified provider version')
    previous_commit = application(provider).get('git_commit_sha')
    require(provider.request('GET', '/deployments') == [], 'Wait for existing provider deployments to finish')
    warnings = scan(images) or []  # Includes unchanged companion and optional service images.
    inspect_sources(images, revisions)
    provider.request('PATCH', '/applications/' + APP, {'git_commit_sha': commit})
    try:
        # The pinned commit is re-read on both sides of the queue check so a
        # concurrent change between PATCH and POST cannot slip through.
        application(provider, commit)
        require(provider.request('GET', '/deployments') == [], 'Provider queue changed during admission')
        application(provider, commit)
    except Rejected as error:
        raise Rejected(str(error) + '; ' + restore_commit(provider, previous_commit)) from None
    queued = provider.request('POST', '/deploy?uuid=' + APP + '&force=false')
    entries = queued.get('deployments', []) if isinstance(queued, dict) else []
    require(isinstance(entries, list) and len(entries) == 1 and isinstance(entries[0], dict) and entries[0].get('resource_uuid') == APP, 'Unexpected deployment resource selection')
    identifier = entries[0].get('deployment_uuid')
    require(isinstance(identifier, str) and re.fullmatch('[a-zA-Z0-9_-]{16,64}', identifier), 'No valid deployment receipt')
    # The backend's own healthcheck can legitimately need ~10 minutes
    # (start_period 600s); never give up on the runtime before that.
    runtime_budget = max(runtime_timeout, healthcheck_budget(document))
    deadline = clock() + timeout
    while clock() < deadline:
        result = provider.request('GET', '/deployments/' + identifier)
        require(isinstance(result, dict), 'Invalid deployment receipt')
        require(result.get('deployment_uuid') == identifier and result.get('commit') == commit, 'Deployment receipt identity/commit mismatch')
        status = result.get('status')
        require(status in ('queued', 'in_progress', 'finished'), 'Deployment failed or returned an unsupported status')
        if status == 'finished':
            state = application(provider, commit)
            raw_compose = state.get('docker_compose_raw')
            require(isinstance(raw_compose, str) and json_document(raw_compose) == document, 'Provider loaded a different Compose definition')
            runtime_deadline = clock() + runtime_budget
            while True:
                try:
                    actual = verify(document, images)
                    break
                except NotReady:
                    require(clock() < runtime_deadline, 'Runtime did not become ready')
                    sleep(5)
                    application(provider, commit)
            outcome = {'deployment_uuid': identifier, 'infra_commit': commit, 'verified_services': sorted(actual)}
            if warnings:
                outcome['scan_warnings'] = sorted(warnings)
            return outcome
        sleep(min(10, max(0, deadline - clock())))
    raise Rejected('Deployment verification timed out; inspect before retrying')


@contextlib.contextmanager
def release_lock(path):
    with open(path, 'a', encoding='utf-8') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Rejected('Another coordinated release is already running') from None
        yield


def load_unique_yaml(raw):
    """Safe YAML load that rejects duplicate keys but still honours `<<: *anchor`
    merges, where an explicit key may legitimately override a merged one."""
    try:
        import yaml
    except ImportError:
        raise Rejected('Install the pinned requirements-release.txt in an isolated environment to prepare YAML') from None

    class UniqueLoader(yaml.SafeLoader):
        pass

    merge_tag = 'tag:yaml.org,2002:merge'

    def unique_mapping(loader, node, deep=False):
        seen = set()
        for key_node, _ in node.value:
            if key_node.tag == merge_tag:
                continue
            key = loader.construct_object(key_node, deep=deep)
            require(isinstance(key, str) and key not in seen, 'Duplicate or non-string YAML field')
            seen.add(key)
        # flatten_mapping puts merged pairs first, so explicit keys win below.
        loader.flatten_mapping(node)
        result = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            require(isinstance(key, str), 'Duplicate or non-string YAML field')
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)
    try:
        return yaml.load(raw, Loader=UniqueLoader)
    except yaml.YAMLError:
        raise Rejected('Invalid source Compose YAML') from None


def prepare_release(argv):
    parser = argparse.ArgumentParser(description='Prepare a new review directory; never deploy or overwrite the source Compose file.')
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--images', required=True, type=Path)
    parser.add_argument('--backend-revision', required=True)
    parser.add_argument('--frontend-revision', required=True)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--trivyignore', type=Path, help='Optional reviewed Trivy ignore file, pinned by hash in the manifest')
    args = parser.parse_args(argv)
    require(SHA.fullmatch(args.backend_revision) and SHA.fullmatch(args.frontend_revision), 'Sources must be immutable commits')
    require(re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}', args.release_id), 'Invalid release ID')
    require(not args.output.exists(), 'Prepare requires a new output directory; existing files are preserved')
    raw = args.source.read_bytes()
    require(len(raw) <= 5 * 1024 * 1024, 'Source Compose exceeds size limit')
    document = load_unique_yaml(raw)
    images = json_document(args.images.read_bytes())
    compiled = compile_compose(document, images)
    try:
        contents = (json.dumps(compiled, indent=2, allow_nan=False) + '\n').encode()
    except (ValueError, TypeError, RecursionError):
        raise Rejected('Compose cannot be represented without ambiguous/cyclic YAML values') from None
    manifest = {'schema': 1, 'application_uuid': APP, 'compose_sha256': hashlib.sha256(contents).hexdigest(),
                'images': images, 'source_revisions': {'backend': args.backend_revision, 'frontend': args.frontend_revision}}
    ignore = None
    if args.trivyignore is not None:
        ignore = args.trivyignore.read_bytes()
        require(len(ignore) <= 256 * 1024, 'trivyignore exceeds size limit')
        strict_text(ignore, 'trivyignore')
        manifest['trivyignore'] = {'path': 'releases/security/' + args.release_id + '.trivyignore',
                                   'sha256': hashlib.sha256(ignore).hexdigest()}
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / COMPOSE).write_bytes(contents)
    manifest_path = args.output / 'releases/security' / (args.release_id + '.json')
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    if ignore is not None:
        (args.output / manifest['trivyignore']['path']).write_bytes(ignore)
    print(json.dumps({'status': 'prepared-for-review-only', 'output': str(args.output), 'production_changed': False}))

def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'prepare':
        prepare_release(sys.argv[2:])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--commit', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true',
                        help='Redeploy a previously admitted manifest: digests, provenance and host identity are still '
                             'enforced, but HIGH/CRITICAL findings published since admission warn instead of block')
    parser.add_argument('--runtime-timeout', type=int, default=DEFAULT_RUNTIME_TIMEOUT,
                        help='Seconds to wait for healthy services after the provider finishes '
                             '(raised automatically to the Compose healthcheck budget)')
    args = parser.parse_args()
    require(60 <= args.runtime_timeout <= 3600, 'Runtime timeout must be between 60 and 3600 seconds')
    bundle, document, ignore = git_bundle(args.repo.resolve(), args.commit, args.manifest)
    if not args.apply:
        print(json.dumps({'status': 'plan-valid-only', 'images': len(set(bundle['images'].values())),
                          'rollback': args.rollback, 'production_changed': False}))
        return
    with release_lock('/var/lock/hive-secure-release-' + APP + '.lock'):
        # Keep failed pulls/scans ahead of provider mutation or service replacement.
        root = json_document(run(['docker', 'info', '--format', '{{json .DockerRootDir}}']))
        require(isinstance(root, str) and root, 'Invalid Docker root directory')
        require(shutil.disk_usage(root).free >= 5 * 1024**3, 'Insufficient Docker disk headroom')
        provider = Provider(os.environ.get('COOLIFY_API_BASE_URL', 'https://deploy.techiveet.com/api/v1'), os.environ.get('COOLIFY_API_TOKEN', ''))
        result = deploy(provider, args.commit, document, bundle['images'], bundle['source_revisions'],
                        scan=lambda images: scan_images(images, ignore=ignore, rollback=args.rollback),
                        runtime_timeout=args.runtime_timeout)
        print(json.dumps({'status': 'image-binding-verified', 'rollback': args.rollback, **result}))


def entrypoint(run_main=None):
    try:
        (run_main or main)()
    except Rejected as error:
        print('Release rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('Release interrupted; inspect the provider before retrying', file=sys.stderr)
        sys.exit(130)
    except Exception as error:  # noqa: BLE001 - never leak tracebacks/provider data
        print('Release rejected: unexpected internal error (' + type(error).__name__ + '); '
              'no provider/body output emitted; inspect before retrying', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    entrypoint()
