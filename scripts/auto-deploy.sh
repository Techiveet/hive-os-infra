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

running_image() {
  docker inspect --format '{{.Image}}' "$1" 2>/dev/null
}

f_run=$(running_image hive-frontend)

# Refresh both images before attempting a rollout.
if ! $COMPOSE pull backend frontend; then
  echo ">> DEPLOY FAILED: could not pull both release images"
  exit 1
fi

if ! b_new=$(docker image inspect "$BIMG" --format '{{.Id}}') ||
   ! f_new=$(docker image inspect "$FIMG" --format '{{.Id}}') ||
   [ -z "$b_new" ] || [ -z "$f_new" ]; then
  echo ">> DEPLOY FAILED: could not identify both candidate images"
  exit 1
fi

backend_changed=false
for service in backend queue reverb scheduler; do
  if [ "$(running_image "hive-$service")" != "$b_new" ]; then
    backend_changed=true
    break
  fi
done

if [ "$backend_changed" = true ]; then
  echo ">> backend services differ from ${b_new:0:19}; deploying"
  # Back up and migrate with the candidate image before replacing the live services.
  if ! $COMPOSE run --rm --no-deps --pull never -T backend php artisan hive:deploy --force; then
    echo ">> DEPLOY FAILED: candidate backup, migration or seeding failed"
    exit 1
  fi
  if ! $COMPOSE up -d --pull never --wait --wait-timeout 240 backend queue reverb scheduler; then
    echo ">> DEPLOY FAILED: backend services did not become ready"
    exit 1
  fi
  echo ">> backend deploy done"
else
  echo "backend: no change"
fi

if [ "$f_run" != "$f_new" ]; then
  echo ">> frontend changed ${f_run:0:19} -> ${f_new:0:19}; deploying"
  if ! $COMPOSE up -d --pull never --wait --wait-timeout 240 frontend; then
    echo ">> DEPLOY FAILED: frontend did not become ready"
    exit 1
  fi
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
if [ "${SKIP_HEALTHCHECK_GATE:-0}" != "1" ]; then
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

echo "=== done ==="
