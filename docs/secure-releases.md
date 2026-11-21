# Coordinated immutable Hive releases

This is a source implementation awaiting cutover acceptance. No production bundle
has been published by this hardening task. Do not merge the producer/entrypoint
transition by itself or treat the existing VPS YAML as an admitted release.

The application workflows publish scanned backend, frontend and Ollama candidates.
The infrastructure image workflow builds and scans ffmpeg, video-backend,
seaweedfs-bootstrap and the optional Caddy image. They do not deploy Coolify.
The only new release consumer is `scripts/secure_release.py`, run on the verified
Docker host. It uses the existing Coolify application and storage layout.

## Prepare a reviewable bundle

Use an isolated Python environment with `requirements-release.txt`. Assemble an
image-map JSON object containing every service in `docker-compose.prod.vps.yml`.
Values must be full immutable repository@sha256 references, including retained
companion and optional images. Four PHP services must use the same backend image.
Use the successful producer digests and resolve third-party digests explicitly;
do not derive identity from `latest`, a local SHA-looking tag, or a scan-passed flag.
The consumer rescans every unique image on linux/amd64 before provider mutation.

Run preparation into a new directory:

```sh
python scripts/secure_release.py prepare \
  --source docker-compose.prod.vps.yml --images "$IMAGE_MAP" \
  --backend-revision "$BACKEND_COMMIT" --frontend-revision "$FRONTEND_COMMIT" \
  --release-id "$RELEASE_ID" --output "$NEW_REVIEW_DIRECTORY"
```

This command accepts the current YAML, rejects duplicate mapping keys, removes
build contexts, adds explicit linux/amd64 platforms and pull policies, and substitutes
only the supplied image references. Existing commands, mount definitions, environment
references, health checks and network topology are preserved. It writes JSON Compose
(valid YAML) and `releases/security/<release-id>.json`, including the Compose byte
hash. It refuses an existing output directory and does not overwrite the source.

Review the complete generated Compose and manifest together. Include both in the
same reviewed infra commit, retaining the root Compose filename and base directory.
Keep an approved prior complete bundle for rollback. A legacy host-local image is
not automatically an approved rollback bundle. Building/publishing those artifacts,
hosted CI and the actual first secure rollback baseline remain release prerequisites.

## Admission and deployment

Read-only plan validation from a clean reviewed infra checkout:

```sh
python scripts/secure_release.py --commit "$INFRA_COMMIT" \
  --manifest "releases/security/$RELEASE_ID.json"
```

Validation reads committed Git bytes, not the working tree or a branch head. The
selected commit must be an ancestor of `refs/remotes/origin/main`; if it is not
(or that ref is stale), run `git fetch origin` on the host and retry. A dirty tracked tree,
wrong Git remote, missing companion image, mutable/interpolated image, local build,
inline Dockerfile, unexpected destination or optional core service is rejected.

Only after the entire master prompt is accepted, execute on the verified VPS host
using a privately configured `COOLIFY_API_TOKEN` and the intended API URL:

```sh
python scripts/secure_release.py --commit "$INFRA_COMMIT" \
  --manifest "releases/security/$RELEASE_ID.json" --apply
```

The token must permit reading sensitive configuration so missing/hidden command
fields cannot be mistaken for empty hooks. Do not pass the token as an argument,
commit it, or print the provider response. The consumer refuses redirects and
withholds provider error bodies. A trigger timeout is ambiguous; inspect the queue
before retrying. No POST retry or automatic database rollback is performed.

The host lock serializes normal releases, redeployments and prior-bundle rollback.
Admission verifies the known Docker engine, architecture, Coolify 4.5.3 contract,
single destination/server connection, repository/layout, and an idle provider queue.
It requires automatic/preview deployments, raw mode and build-server mode disabled.
Legacy autodeploy service/timer units must be absent or inactive and disabled/masked.
Opaque pre/post/custom build/start hooks and inline Dockerfiles are rejected. The
consumer never silently changes these settings or retargets the repository.

The current live app has automatic deployment enabled, selects HEAD, and has a
pre-deployment command. Those are known cutover blockers. Review the hook's purpose
and preserve its necessary behavior before changing it. Do not clear it merely to
satisfy the check. Provider cutover remains covered by the user's conditional release
authorization only once the full prompt, configuration review and acceptance pass.

After all image scans and source-label checks, the only configuration PATCH pins
`git_commit_sha`. Read-back must retain the intended app, source, destination and
mode. The single returned deployment receipt must select the correct UUID and the
finished receipt must match the commit. The loaded raw Compose must match the
committed definition. Docker container Config.Image, actual image ID and local
RepoDigests are independently compared with the bundle, and core services must be
running and healthy. This verifies image binding; it does not prove migration
success, financial workflows, HTTPS, proxy behavior or all ERP acceptance.

### Scanning, timeouts and failure recovery

Each unique image is pulled once with the host's own registry login, exported with
`docker save`, and scanned offline from that archive; the scanner never receives
registry credentials. The Trivy vulnerability and Java DBs are refreshed once per
release into the persistent `hive-trivy-cache` volume and every per-image scan runs
with `--skip-db-update --skip-java-db-update --ignore-unfixed`. Set `HIVE_SCAN_TMPDIR`
to a roomy filesystem if `/tmp` cannot hold the largest image archive.

A reviewed `.trivyignore` may be pinned in the manifest as
`"trivyignore": {"path": "releases/security/<release-id>.trivyignore", "sha256": "..."}`
(`prepare --trivyignore FILE` writes both). The bytes are read from the admitted
commit and must match the hash.

After the provider reports `finished`, the runtime wait is the larger of
`--runtime-timeout` (default 660 s) and the Compose healthcheck budget
(`start_period + (interval + timeout) * retries`), so the backend's 600 s start
period is never cut short. If admission fails after the commit PATCH but before the
deployment POST, the previous `git_commit_sha` is PATCHed back and the rejection
states whether that restoration was confirmed. Failed commands report the program,
subcommand and image reference only; unexpected internal errors exit 1 with the
exception type and no traceback or provider data.

## Rollback and limits

Redeploy an approved previous manifest/commit through the same command and scans.
Add `--rollback` when redeploying a previously admitted manifest: digests,
provenance labels, Git ancestry and host identity are enforced exactly as for a
release, but HIGH/CRITICAL findings published after that bundle was admitted are
printed as warnings (and returned as `scan_warnings`) instead of blocking. Pull or
scanner failures still reject.
Preserve volumes, reservations, application encryption keys and customer writes.
Never run down migrations or automatically restore a database as image rollback.
If admission, scanning or health fails, stop and inspect; do not switch to the legacy
mutable-tag scripts. Their source entrypoints now delegate to this consumer.

Local tests cover admission failure classes, preparation of the actual VPS topology,
Git byte/hash binding, simulated provider outcomes and concurrency. A disposable
Docker fixture verifies the actual image identity primitive. Full disposable Coolify
control-plane deployment, real bundle scans/builds, hosted execution and production
cutover/rollback are not claimed complete. The previous standalone runtime helpers
that echo expected constants are not evidence for this consumer.