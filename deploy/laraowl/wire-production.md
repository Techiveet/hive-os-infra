# Wiring production hive → LaraOwl

How to make the production hive backend (hive.gulfingot.com) send telemetry to
the LaraOwl instance, attributed to the **hive.gulfingot.com** project.

## Prerequisites (both are required)

### 1. LaraOwl must have a public URL

The production VPS cannot reach a `localhost` instance. This stack currently
listens only on the dev machine. Choose one:

- **Recommended — deploy LaraOwl to the VPS** (or any public host) with the
  upstream compose and a real `APP_HOSTNAME`, e.g. `hive-monitor.gulfingot.com`.
  Follow `README.md` in this directory; use `laraowl/docker-compose.yaml`
  WITHOUT the local override layers so auto-HTTPS applies, and set
  `APP_URL=https://hive-monitor.gulfingot.com`.
- Dev-only alternative: a tunnel (e.g. cloudflared) exposing `localhost:8000` —
  fine for smoke tests, not for production monitoring.

### 2. The production backend image must include the LaraOwl client

`laraowl/client` was added to `hive-os-backend` (composer) AFTER the current
`ghcr.io/techiveet/hive-os-backend:latest` image was built. The production
image must be rebuilt and pushed with the client included, then redeployed via
the existing pipeline (`hive-os-infra/scripts/build-and-push.sh` +
`deploy-prod.sh`).

## Env block for the production backend

On the VPS, in the backend service's `.env` (the compose uses `env_file: .env`):

```ini
LARAOWL_ENABLED=true
LARAOWL_SERVER_URL=https://hive-monitor.gulfingot.com   # the public URL from prerequisite 1
LARAOWL_TOKEN=<project api_token from the LaraOwl dashboard; never commit it>
LARAOWL_SERVER_NAME=hive-os-backend
```

The token is project 2's (`hive.gulfingot.com`) api_token. Keep it only in
the server's `.env`. A value was committed to this file until 2026-09; it must
be treated as leaked and rotated in the dashboard (or via
`UPDATE projects SET api_token=... WHERE id=2;`).

Then restart the backend so Octane picks it up:
`docker compose -f docker-compose.prod.vps.yml restart backend`

## Verify after wiring

Within ~a minute of production traffic, the hive.gulfingot.com dashboard
should show telemetry (requests/queries/commands) and its threshold engine
becomes live. Checks:

```bash
# On the LaraOwl host
docker exec laraowl-db-1 psql -U laraowl -d laraowl -c \
  "SELECT type, count(*) FROM records WHERE project_id=2 GROUP BY type ORDER BY count DESC;"

# Requests view: http://<laraowl-public-url>/hive-erp/requests  (period 1h)
# Expect records with server=hive-os-backend, real production routes, durations
```

If nothing arrives: confirm the client env is loaded
(`docker compose exec backend php artisan about` or `php artisan config:show laraowl`),
check outbound HTTPS from the VPS to the LaraOwl public URL
(`curl -s -o /dev/null -w '%{http_code}' https://hive-monitor.gulfingot.com/up`),
and tail the backend logs for `Laraowl Ingest Error` (the client fails soft by
design — it logs, never breaks requests).

## Note on alert delivery

The Telegram/Slack test integrations on both projects currently point at the
local capture harness. Production alert delivery needs a real bot token/chat id
(see README.md → Telegram alerts) — the capture `api_base` must be removed for
real delivery.
