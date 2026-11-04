# LaraOwl server — deployment (hive-os-infra)

Self-hosted monitoring platform for Laravel apps. The server repo lives at
`hive-os-infra/laraowl/` (clone of https://github.com/laraowl/laraowl, pinned
by its `composer.lock`). This directory holds the local deployment glue for
this machine.

## Stack

| Service      | Image/role                                  | Notes                                   |
|--------------|---------------------------------------------|-----------------------------------------|
| `app`        | `laraowl:latest` (built from repo Dockerfile) | Laravel app, PHP-FPM + migrations on boot |
| `db`         | `postgres:17-alpine`                        | `laraowl` database                       |
| `redis`      | `bitnami/redis:latest`                      | cache + queue (Horizon)                  |
| `horizon`    | same app image, `horizon` command           | queue workers                            |
| `schedule-worker` | same app image, `schedule:work`        | scheduler                                |
| `reverb`     | same app image, `reverb:start`              | websockets (`/app*` proxied by Caddy)    |
| `caddy`      | `caddy:2-alpine`                            | reverse proxy, port **8000** (host)      |

The app image runs `npm run build` for the dashboard during `docker build`, so
the Vite assets ship inside the image and are served through Caddy.

## Bring it up

From `hive-os-infra`:

```bash
docker compose -f laraowl/docker-compose.yaml \
  -f deploy/laraowl/docker-compose.override.yml \
  -f deploy/laraowl/docker-compose.local.yml up -d --build
```

**Gotcha:** always use the full three-file command — including for
`down`/`stop`/`up`. A bare `docker compose -f laraowl/docker-compose.yaml
down` only tears down the *upstream* layer, so the caddy container is
recreated without the local layer's `8000:80` mapping and the dashboard
becomes unreachable at `localhost:8000` (the hive client's
`LARAOWL_SERVER_URL` also breaks). Recover with the full three-file `up -d`.

Why three files:

- `laraowl/docker-compose.yaml` — upstream stack (ports 80/443, HTTPS Caddyfile,
  redis/horizon/reverb/scheduler).
- `deploy/laraowl/docker-compose.override.yml` — **reset layer**: nulls out the
  upstream caddy `ports`/`volumes` (compose `!reset null`). Needed because the
  upstream bind-mounts `./docker/Caddyfile` and we can't remove it any other way.
- `deploy/laraowl/docker-compose.local.yml` — **local layer**: caddy on host
  port `8000:80`, binds `Caddyfile.local` (plain HTTP, no ACME — this is local
  dev; `localhost` in dev), HTTP healthcheck.

The app itself is configured via `hive-os-infra/laraowl/.env` (gitignored;
secrets generated locally, `APP_URL=http://localhost:8000`).

## First-time bootstrap

The stack starts with an empty DB. With registration disabled, seed the
operator account, team and project once:

```bash
docker exec -it laraowl-app-1 sh -c "cd /usr/share/caddy/html && php artisan tinker"
```

```php
use App\Actions\Projects\CreateProject;
use App\Actions\Teams\CreateTeam;
use App\Models\User;

$user = User::create(['name' => 'Hive Admin', 'email' => 'admin@hive.os', 'password' => 'CHANGE_ME']);
$user->email_verified_at = now();
$user->save();
$team = app(CreateTeam::class)->handle($user, 'Hive ERP', isPersonal: true);
$project = app(CreateProject::class)->handle($team, 'Hive ERP', 'http://localhost:8000', 'admin@hive.os');
echo $project->api_token;
```

The first user is the **instance operator**. The printed `api_token` is what
the hive backend client authenticates with.

## Hive client wiring

`hive-os-backend/.env` (gitignored):

```ini
LARAOWL_ENABLED=true
LARAOWL_SERVER_URL=http://host.docker.internal:8000
LARAOWL_TOKEN=<project api_token from above>
LARAOWL_SERVER_NAME=hive-os-backend
```

Note `host.docker.internal` — the client runs inside the `hive-backend`
container, so it reaches the published host port via the Docker Desktop host
gateway. From the browser/host, the public URL is `http://localhost:8000`.

After changing `.env`, restart the backend so Octane picks it up:
`docker restart hive-backend`.

## Telegram alerts

Alert rules dispatch through project integrations (`IntegrationService`).
The Telegram driver POSTs `{chat_id, text, parse_mode}` to
`https://api.telegram.org/bot<token>/sendMessage` (Markdown text). Both
projects' Telegram integrations are attached to the outage (`uptime_down`)
and latency (`high_latency`) rules (plus `sustained_error_spike`).

**Live status:** the **@laraowletbot** bot is wired to both projects — id 4
(`hive.gulfingot.com`) and id 5 (Hive ERP) carry the real `bot_token` +
`chat_id` (private chat `734736898`) with **no** `api_base`, so alerts deliver
to real Telegram. Verified with a live outage test: DOWN 🚨 and recovery ✅
both arrived in the chat. (Project 2 previously pointed at the local capture
fixture; the swap removed `api_base`.)

To change credentials, create a bot with **@BotFather**, find your chat id
(e.g. via @userinfobot), then update the row (or edit in the dashboard UI →
Integrations):

```bash
docker exec laraowl-db-1 psql -U laraowl -d laraowl -c \
  "UPDATE integrations SET data='{\"bot_token\":\"<token>\",\"chat_id\":\"<chat_id>\"}'::jsonb WHERE id=4;"
```

For local verification the driver honors an optional `data.api_base` override
(added to `IntegrationService::sendToTelegram`; defaults to the public Bot
API, and also supports self-hosted Bot API servers). A durable capture
container (`laraowl-hook`, named volume + `restart: unless-stopped`) on the
laraowl network mimics the Bot API — POST `/bot<token>/sendMessage` → logs to
`/tmp/telegram_hook_captures.log` → `{"ok":true}`. Point an integration at it
via `api_base: http://laraowl-hook:9999` to re-verify without a real bot; drop
`api_base` and use a real token to deliver for real.

## Realtime (Reverb) in the local stack

The dashboard's websocket config is baked into the JS bundle at build time
from `VITE_REVERB_*` in `.env`. The local stack overrides the production
template values:

```ini
VITE_REVERB_HOST="localhost"
VITE_REVERB_PORT="8000"
VITE_REVERB_SCHEME="http"
```

This makes Echo connect to `ws://localhost:8000/app/<key>`, which Caddy
proxies to the `reverb` service — verified connected with the dashboard
subscribed to `private-project.<id>`, counters updating in-place as traffic
arrives. Server-side `REVERB_*` (host `reverb`, port 8080) were already local.

**Gotcha — rebuilding the image is not enough:** the compose stack mounts
`public:/usr/share/caddy/html/public:ro` as a persistent named volume, which
shadows the image's freshly built assets. After any frontend rebuild you must
drop the volume so it re-initializes from the new image:

```bash
docker compose -f laraowl/docker-compose.yaml \
  -f deploy/laraowl/docker-compose.override.yml \
  -f deploy/laraowl/docker-compose.local.yml down
docker volume rm laraowl_public
docker compose -f laraowl/docker-compose.yaml \
  -f deploy/laraowl/docker-compose.override.yml \
  -f deploy/laraowl/docker-compose.local.yml up -d
```

(`public` holds only built assets; user uploads live in the `storage` volume,
which is untouched.)

## Production project (hive.gulfingot.com)

The `hive.gulfingot.com` project has its own monitoring setup:

- Alert rules: the four defaults plus **Slow Performance Alert** (`high_latency`)
  and **Sustained High Error Rate** (`sustained_error_spike`) so latency
  violations and *sustained* error storms page the team, not just outages and
  single-window spikes.
- Integrations: Default Email + Telegram (attached to the `uptime_down`,
  `high_latency`, and `sustained_error_spike` rules).

### Sustained High Error Rate rule

Fires when the exception count stays above the project's spike threshold across
**consecutive windows** (`IngestService::detectSustainedErrorRate`):

- Per-window criteria reuse the project's existing `spike_threshold`
  (default 50) and `spike_window` (default 5 min); the number of consecutive
  qualifying windows is `sustained_windows` (default 3).
- Evaluated once per ingest batch, **after** the batch's records are created
  (per-exception evaluation under-counts a partial batch), and at most once
  per window via `sustained_checked_at`. The consecutive counter advances one
  step per qualifying window and resets when a window falls below threshold.
- On the `sustained_windows`-th consecutive window it pages 🔁 *Sustained High
  Error Rate* (Telegram + email) and re-arms for the next episode. The rule's
  `throttle_period` (default 1 h) still applies per message.
- Verified end-to-end with 2×2 injected exceptions across two simulated
  1-minute windows (threshold 2): the second consecutive window delivered
  `🔁 Sustained High Error Rate — Last Window Count: 4 — Consecutive Windows:
  2 × 1m` to the Telegram capture.
- Thresholds (`thresholds` table, values in **ms**; ingest durations are
  microseconds, so the service compares `duration > value * 1000`) cover
  **routes, jobs, commands, and scheduled tasks** — slow background work pages
  Telegram too, not just slow HTTP:
  - `route`: `/, 2000` · `/up, 1000` · `/api/v1/password-policy, 1000` ·
    `/api/v1/system/health, 1500`
  - `job`: `Modules\Core\Jobs\ProcessClientAuditLog, 30000` (keys on the job
    class `name`)
  - `command`: `tinker, 5000` · `migrate, 30000` · `route:list, 10000`
  - `query`: `select "tag" from "telescope_monitoring", 500` ·
    `insert into "telescope_entries" (...), 500` (the real queries the hive
    backend runs every minute — ready for when production telemetry flows)

Key matching (`IngestService::checkThresholds`): routes key on the exact
`route_path`; **jobs key on the job class `name`**; commands and scheduled
tasks key on the command **`name`** (the engine prefers `name` over the full
signature, so a threshold on `tinker` fires for any invocation with args, not
just one exact signature); **queries key on the SQL text** — the client
already strips bindings, and the engine collapses whitespace + caps at the
255-char `key` column so oddly-formatted SQL still matches
(`Threshold::normalizeKey`, applied on both insert and lookup). All are exact
matches, no wildcards — add more from the dashboard UI (Projects →
Thresholds) as the API surface grows (the UI's *Add Query Threshold* is
supported; `ThresholdController` accepts `query`).

Verified end-to-end: a crafted 45s audit-log job fired `Slow Job:
Modules\Core\Jobs\ProcessClientAuditLog` (issue + ⏱️ High Latency Telegram)
and an 8s `tinker` command fired `Slow Command: tinker` the same way; fast
control records did not fire.

**Ingest payload contract** (`IngestController`): the body must be valid JSON
that decodes to either the client's `{"records": [...]}` envelope, a single
record object, or a list of records; every record must carry a non-empty `"t"`
(type) field. Anything else — malformed JSON (e.g. broken `\` escapes, which
previously arrived as an *empty* body and silently vanished), a missing `t`,
or a non-array `records` — returns **422** with a message naming the bad
record. `{"records": []}` is accepted as a no-op. Validated before dispatch,
so the worker only ever sees well-formed records.

**Prerequisite for latency alerts to matter:** thresholds fire on ingested
records, and the production backend currently sends no telemetry here. On the
production hive server set:

```ini
LARAOWL_ENABLED=true
LARAOWL_SERVER_URL=<this instance's public URL>
LARAOWL_TOKEN=<project 2's api_token>
LARAOWL_SERVER_NAME=hive-os-backend
```

(mint the token per project in the dashboard and rotate before sharing; the
token printed during deployment is dev-only.) Once the production client
reports, real request durations flow through `IngestService::checkThresholds`
and slow routes create issues + `high_latency` alerts.

## Horizon dashboard access

Horizon's default gate denies everyone (`403` on `/horizon`). The app defines
its own gate in `app/Providers/AppServiceProvider.php::configureHorizon()`:

```php
Horizon::auth(fn ($request) => (bool) $request->user()?->isInstanceOperator());
```

Only the **instance operator** (the first user, `admin@hive.os`) can view
`/horizon`; other users and anonymous requests are denied. If you recreate the
app containers, the gate ships in the image — no extra steps.

## Flaky-network builds: composer cache image

codeload.github.com stalls from some networks; composer downloads can hang.
The Dockerfile's composer step mounts a cache from a local image
(`--mount=type=cache,from=laraowl_composer_cache,source=/c`) instead of
BuildKit's opaque cache, so downloads can be pre-warmed once and reused:

```bash
# 1. Pre-warm the cache volume (retry the install until it exits 0)
docker run -d --name laraowl-cwarm --entrypoint sh -v laraowl_composer_cache:/cache composer:2 -c "sleep 3600"
docker cp composer.json laraowl-cwarm:/app/composer.json
docker cp composer.lock laraowl-cwarm:/app/composer.lock
docker exec laraowl-cwarm sh -c "cd /app && COMPOSER_CACHE_DIR=/cache composer install --no-dev --no-interaction --no-progress --no-scripts --ignore-platform-reqs"
docker rm -f laraowl-cwarm

# 2. Bake the cache into a local image the Dockerfile can mount
MSYS_NO_PATHCONV=1 docker run --rm -v laraowl_composer_cache:/cache alpine \
  sh -c "cd /tmp && mkdir -p c && cp -a /cache/. c/ && tar cf - c" > /tmp/cache.tar
docker import /tmp/cache.tar laraowl_composer_cache:latest
```

Refresh the image whenever `composer.lock` changes. (The `MSYS_NO_PATHCONV=1`
prefix is only needed under Git Bash on Windows.)

## Uptime monitoring

`projects:check-health` runs every 30s (`routes/console.php`) via the
`schedule-worker` container. It GETs each project's `url` (2 retries, 10s
timeout), records an `uptime_checks` row, and fires alerts on up/down
transitions through the project's alert rules + integrations (mailer is `log`
in local dev, so alert mails land in `storage/logs/laravel.log`).

To point a project at the hive backend from inside the LaraOwl container, the
URL must use the Docker Desktop host gateway (bare `localhost` would be the
container itself):

```bash
docker exec laraowl-db-1 psql -U laraowl -d laraowl -c \
  "UPDATE projects SET url='http://host.docker.internal:8081/up', last_uptime_check_at=NULL WHERE id=1;"
```

(`host.docker.internal:8081` is the hive backend's published host port.
`last_uptime_check_at=NULL` forces the next scheduled check immediately;
otherwise the 60s interval filter skips projects checked recently.)

## Verify

- Dashboard: http://localhost:8000 — sign in with the operator credentials.
- Ingestion: `docker exec laraowl-db-1 psql -U laraowl -d laraowl -c "SELECT type, count(*) FROM records GROUP BY type;"` — should show `request`/`query`/`command`/`cache-event` rows shortly after hive traffic.
- Websockets: `curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://localhost:8000/app/health` → `101`.

## Production

- Use the upstream `docker-compose.yaml` **without** the local layers, with a
  real `APP_HOSTNAME` (auto-HTTPS via the baked Caddyfile) and `APP_URL`.
- Point `LARAOWL_SERVER_URL` at the public URL and mint a fresh token per
  project (Project Settings → API Keys). The token above is a dev token —
  rotate it before any shared environment.
- `composer.lock` was regenerated once locally because the upstream lock no
  longer matches its `composer.json` (`composer validate --strict` was failing).
  Keep it in sync with upstream releases.

## Stop / teardown

```bash
docker compose -f laraowl/docker-compose.yaml -f deploy/laraowl/docker-compose.override.yml -f deploy/laraowl/docker-compose.local.yml down
# full reset (drops data):
docker compose -f laraowl/docker-compose.yaml -f deploy/laraowl/docker-compose.override.yml -f deploy/laraowl/docker-compose.local.yml down -v
```
