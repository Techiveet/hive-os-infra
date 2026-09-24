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

docker image prune -f >/dev/null 2>&1 || true
echo "=== done ==="
