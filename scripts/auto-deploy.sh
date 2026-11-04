#!/usr/bin/env bash
# Pull-based deploy for the Hive stack.
#
# Why: the VPS firewall (Hetzner Cloud Firewall) blocks inbound SSH from GitHub
# Actions runners, and we intentionally keep SSH closed to the public internet.
# So instead of GitHub pushing a deploy over SSH, the VPS watches GHCR and
# redeploys itself when a new :latest image appears.
#
# Installed as a systemd timer (see hive-autodeploy.service / .timer), runs every
# ~2 minutes. Safe to run by hand: `systemctl start hive-autodeploy.service`.
set -uo pipefail
cd /root/projects/hive || exit 1

# single-instance lock (skip if a run is already in progress)
exec 9>/var/lock/hive-autodeploy.lock
flock -n 9 || exit 0

LOG=/root/projects/hive/storage/logs/auto-deploy.log
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date -Is) check ==="

COMPOSE="docker compose -f docker-compose.prod.yml"
BIMG=ghcr.io/techiveet/hive-os-backend:latest
FIMG=ghcr.io/techiveet/hive-os-frontend:latest

b_run=$(docker inspect --format '{{.Image}}' hive-backend 2>/dev/null)
f_run=$(docker inspect --format '{{.Image}}' hive-frontend 2>/dev/null)

# refresh manifests (cheap when unchanged). Do NOT silence this: a failed pull
# (expired GHCR login, full disk, etc.) must be visible in the log, otherwise the
# digest comparison below just sees the stale local image and reports "no change"
# forever — hiding a broken registry login behind a healthy-looking deploy loop.
if ! $COMPOSE pull backend frontend; then
  echo ">> WARNING: 'compose pull' failed (registry auth / disk / network?) — falling back to whatever images are already local. Run 'docker login ghcr.io' if this is an auth error."
fi

b_new=$(docker image inspect "$BIMG" --format '{{.Id}}' 2>/dev/null)
f_new=$(docker image inspect "$FIMG" --format '{{.Id}}' 2>/dev/null)

if [ -n "$b_new" ] && [ "$b_run" != "$b_new" ]; then
  echo ">> backend changed ${b_run:0:19} -> ${b_new:0:19}; deploying"
  $COMPOSE up -d backend queue reverb scheduler
  for i in $(seq 1 24); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' hive-backend 2>/dev/null)" = healthy ] && break
    sleep 5
  done
  $COMPOSE exec -T backend php artisan storage:link || true
  $COMPOSE exec -T backend php artisan optimize:clear
  $COMPOSE exec -T backend php artisan migrate --force
  $COMPOSE exec -T backend php artisan tenants:migrate --force
  $COMPOSE exec -T backend php artisan hive:sync-system-access --force || true
  $COMPOSE exec -T backend php artisan config:cache
  $COMPOSE exec -T backend mkdir -p /var/www/html/Modules/Subscription/app/resources/views || true
  $COMPOSE exec -T backend php artisan view:cache
  $COMPOSE exec -T backend php artisan octane:reload || true
  echo ">> backend deploy done"
else
  echo "backend: no change"
fi

if [ -n "$f_new" ] && [ "$f_run" != "$f_new" ]; then
  echo ">> frontend changed ${f_run:0:19} -> ${f_new:0:19}; deploying"
  $COMPOSE up -d frontend
  echo ">> frontend deploy done"
else
  echo "frontend: no change"
fi

# Post-deploy gate, for BOTH of the branches above (and even when neither
# changed: an unattended redeployer is also the first witness of drift). The
# healthcheck asserts the full stack contract — containers, endpoints,
# dependencies, scheduler work, object storage, both pre-warmers' adaptive
# behaviour. On failure the deploy is logged as FAILED (so the timer's log and
# any log-shipping alert see it) and the script exits 1; the next timer run
# re-runs the gate instead of papering over a broken stack. Disable with
# SKIP_HEALTHCHECK_GATE=1 for a known-partial deploy.
if [ "${SKIP_HEALTHCHECK_GATE:-0}" != "1" ] && [ -f "scripts/healthcheck.sh" ]; then
  echo ">> running stack healthcheck gate"
  # Env assignments BEFORE the command: as arguments they would reach the
  # healthcheck's option parser and exit 2 — which would fail every deploy.
  # Profile matches docker-compose.prod.yml (see deploy-prod.sh's gate block).
  GATE_PROJECT="$(grep -E '^COMPOSE_PROJECT_NAME=' .env 2>/dev/null | tail -n 1 | cut -d= -f2-)"
  GATE_BACKEND_DOMAIN="$(grep -E '^BACKEND_DOMAIN=' .env 2>/dev/null | tail -n 1 | cut -d= -f2-)"
  GATE_FRONTEND_DOMAIN="$(grep -E '^FRONTEND_DOMAIN=' .env 2>/dev/null | tail -n 1 | cut -d= -f2-)"
  if ! COMPOSE_PROJECT_NAME="${GATE_PROJECT:-$(basename "$(pwd)")}" \
       CORE_SERVICES="caddy backend frontend queue scheduler reverb db redis meilisearch seaweedfs rembg ffmpeg gotenberg prometheus grafana node-exporter cadvisor" \
       ONE_SHOT_SERVICES="seaweedfs-bootstrap" \
       BACKEND_URL="https://${GATE_BACKEND_DOMAIN:-hive-backend.gulfingot.com}" \
       FRONTEND_URL="https://${GATE_FRONTEND_DOMAIN:-hive.gulfingot.com}" \
       ./scripts/healthcheck.sh -q; then
    echo ">> DEPLOY FAILED: stack healthcheck gate did not pass"
    exit 1
  fi
  echo ">> healthcheck gate passed"
fi

docker image prune -f >/dev/null 2>&1 || true
echo "=== done ==="
