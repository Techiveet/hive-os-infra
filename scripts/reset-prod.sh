#!/usr/bin/env bash

set -Eeuo pipefail

if [ "${TRACE_RESET:-0}" = "1" ]; then
  set -x
fi

cd /var/www/hive

# This script drops and re-seeds every production database. Refuse to run
# unless the operator confirms explicitly, either interactively or with
# RESET_PROD_CONFIRM=wipe-production for automation.
if [ "${RESET_PROD_CONFIRM:-}" != "wipe-production" ]; then
  if [ -t 0 ]; then
    printf 'This ERASES all production data (central and every tenant).\nType "wipe-production" to continue: '
    read -r answer
    [ "$answer" = "wipe-production" ] || { echo "Aborted."; exit 1; }
  else
    echo "Refusing to reset production without RESET_PROD_CONFIRM=wipe-production." >&2
    exit 1
  fi
fi

COMPOSE_FILE="docker-compose.prod.yml"
COMPOSE="docker compose -f ${COMPOSE_FILE}"

echo "== Pulling latest code =="
if [ -d ".git" ]; then
  git fetch origin main
  git checkout main
  git pull --ff-only origin main
else
  echo "Not a git repository (no .git folder found). Skipping git pull."
fi

echo "== Confirm Redis PECL compile block is gone =="
if [ -f "backend/Dockerfile.prod" ]; then
  grep -n "pecl.*redis\|redis-6.1.0\|docker-php-ext-enable redis\|/tmp/redis.tgz\|redis-build-deps" backend/Dockerfile.prod && {
    echo "ERROR: Redis PECL compile block still exists. Stop here."
    exit 1
  } || echo "Redis PECL check passed."
else
  echo "Warning: backend/Dockerfile.prod not found, skipping compile block check."
fi

echo "== Force Redis client to Predis in VPS .env =="
if [ -f ".env" ]; then
  if grep -q '^REDIS_CLIENT=' .env; then
    sed -i 's/^REDIS_CLIENT=.*/REDIS_CLIENT=predis/' .env
  else
    printf '\nREDIS_CLIENT=predis\n' >> .env
  fi
else
  echo "Warning: .env file not found, skipping Predis configuration."
fi

echo "== Stop app services =="
$COMPOSE down --remove-orphans

echo "== Backup current app data folder names before wipe =="
mkdir -p /var/www/hive-reset-backups
tar -czf "/var/www/hive-reset-backups/hive-storage-before-reset-$(date +%Y%m%d-%H%M%S).tar.gz" \
  storage/db-data \
  storage/search-data \
  storage/seaweedfs-data \
  2>/dev/null || true

echo "== Wipe database, Meilisearch index data, uploaded object storage, runtime caches =="
rm -rf storage/db-data
rm -rf storage/search-data
rm -rf storage/seaweedfs-data
rm -rf storage/db-backups
rm -rf storage/app-storage
rm -rf backend/storage/framework/cache/*
rm -rf backend/storage/framework/sessions/*
rm -rf backend/storage/framework/views/*
rm -rf backend/bootstrap/cache/*.php
rm -rf backend/storage/logs/*.log

mkdir -p \
  storage/db-data \
  storage/search-data \
  storage/seaweedfs-data \
  storage/db-backups \
  storage/app-storage \
  storage/caddy_runtime \
  storage/caddy_data \
  storage/caddy_config \
  storage/prometheus-data \
  storage/grafana-data \
  backend/storage/framework/cache \
  backend/storage/framework/sessions \
  backend/storage/framework/views \
  backend/storage/logs \
  backend/bootstrap/cache

# Ensure correct permissions for host mounted folders before build/start
chmod -R 775 storage backend/storage backend/bootstrap/cache 2>/dev/null || true
chmod -R 777 storage/prometheus-data storage/grafana-data 2>/dev/null || true

echo "== Rebuild images cleanly =="
$COMPOSE build --progress plain caddy backend queue reverb frontend ffmpeg

echo "== Start dependencies =="
$COMPOSE up -d redis db db-backup seaweedfs seaweedfs-bootstrap meilisearch rembg gotenberg ffmpeg

# Helper function to check container health natively via Docker
wait_for_service() {
  local service="$1"
  local attempts="${2:-36}"
  local attempt=0
  local container_id=""
  local status=""

  while true; do
    container_id="$(docker compose -f "${COMPOSE_FILE}" ps -a -q "${service}" 2>/dev/null | head -n 1 || true)"

    if [ -n "${container_id}" ]; then
      status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || true)"
    else
      status="missing"
    fi

    if [ "${status}" = "healthy" ] || [ "${status}" = "running" ]; then
      echo "${service} is ${status}"
      return
    fi

    attempt=$((attempt + 1))

    if [ "${attempt}" -ge "${attempts}" ]; then
      echo "${service} did not become ready. Last status: ${status}" >&2
      docker compose -f "${COMPOSE_FILE}" logs --tail=150 "${service}" >&2 || true
      exit 1
    fi

    sleep 3
  done
}

wait_for_completed_service() {
  local service="$1"
  local attempts="${2:-36}"
  local attempt=0
  local container_id=""
  local status=""
  local exit_code=""

  while true; do
    container_id="$(docker compose -f "${COMPOSE_FILE}" ps -a -q "${service}" 2>/dev/null | head -n 1 || true)"

    if [ -n "${container_id}" ]; then
      status="$(docker inspect --format='{{.State.Status}}' "${container_id}" 2>/dev/null || true)"
      exit_code="$(docker inspect --format='{{.State.ExitCode}}' "${container_id}" 2>/dev/null || true)"
    else
      status="missing"
      exit_code=""
    fi

    if [ "${status}" = "exited" ] && [ "${exit_code}" = "0" ]; then
      echo "${service} completed successfully"
      return
    fi

    if [ "${status}" = "exited" ] && [ "${exit_code}" != "0" ]; then
      echo "${service} failed with exit code ${exit_code}" >&2
      docker compose -f "${COMPOSE_FILE}" logs --tail=150 "${service}" >&2 || true
      exit 1
    fi

    attempt=$((attempt + 1))

    if [ "${attempt}" -ge "${attempts}" ]; then
      echo "${service} did not complete. Last status: ${status}, exit code: ${exit_code}" >&2
      docker compose -f "${COMPOSE_FILE}" logs --tail=150 "${service}" >&2 || true
      exit 1
    fi

    sleep 3
  done
}

echo "== Wait for db/redis/search/object storage =="
wait_for_service db
wait_for_service redis
wait_for_service meilisearch
wait_for_completed_service seaweedfs-bootstrap

echo "== Start backend =="
$COMPOSE up -d backend
wait_for_service backend

echo "== Clear Redis cache/session/queue data =="
$COMPOSE exec -T redis redis-cli FLUSHALL || true

echo "== Reset central database =="
$COMPOSE exec -T backend php artisan optimize:clear
$COMPOSE exec -T backend php artisan migrate:fresh --seed --force

echo "== Seed central language data =="
$COMPOSE exec -T backend php artisan db:seed --class='Modules\Core\Database\Seeders\LanguageSeeder' --force

echo "== Reset tenant migrations if command exists =="
$COMPOSE exec -T backend php artisan tenants:migrate-fresh --seed --force || \
$COMPOSE exec -T backend php artisan tenants:migrate --force

echo "== Seed tenant language data =="
$COMPOSE exec -T backend php artisan tenants:seed --class='Modules\Core\Database\Seeders\LanguageSeeder' --force || true

echo "== Sync localization =="
$COMPOSE exec -T backend php artisan localization:sync
$COMPOSE exec -T backend php artisan tenants:run localization:sync || true

echo "== Sync system access and fallback domains =="
$COMPOSE exec -T backend php artisan hive:sync-system-access --force || true
$COMPOSE exec -T backend php artisan hive:sync-fallback-domains || true

echo "NOTE: seeded admin accounts use the seeder's default password and must"
echo "      change it on first sign-in (must_change_password is set in production)."

echo "== Rebuild Laravel caches =="
$COMPOSE exec -T backend php artisan optimize:clear
$COMPOSE exec -T backend php artisan config:cache
$COMPOSE exec -T backend php artisan view:cache

$COMPOSE up -d queue reverb scheduler frontend prometheus grafana node-exporter cadvisor caddy
wait_for_service queue
wait_for_service reverb
wait_for_service scheduler
wait_for_service frontend
wait_for_service prometheus
wait_for_service grafana
wait_for_service caddy

echo "== Rebuild Meilisearch indexes =="
$COMPOSE exec -T backend php artisan scout:import-all || true

echo "== Reload Octane and Horizon =="
$COMPOSE exec -T backend php artisan octane:reload || true
$COMPOSE exec -T backend php artisan horizon:terminate || true
$COMPOSE exec -T backend php artisan horizon:clear || true

echo "== Restart frontend/backend/queue/reverb/caddy/monitoring =="
$COMPOSE restart frontend backend queue reverb scheduler prometheus grafana node-exporter cadvisor caddy

echo "== Final status =="
$COMPOSE ps
