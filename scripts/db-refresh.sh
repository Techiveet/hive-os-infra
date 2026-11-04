#!/usr/bin/env bash
#
# db-refresh.sh — rebuild the Hive OS database from scratch in ONE command.
#
# Mirrors the verified procedure in
#   ../hive-os-backend/docs/operations/database-refresh.md
# (central reset → drop tenant DBs → central migrations → full seed cascade
#  → restart workers → verify). A refresh DESTROYS DATA: central is dropped and
# recreated, every tenant database is dropped and re-seeded.
#
# Usage:
#   scripts/db-refresh.sh                  # full refresh (asks for confirmation)
#   scripts/db-refresh.sh --yes            # skip the confirmation prompt
#   scripts/db-refresh.sh --tenants-only   # re-provision tenants only (keeps central app data)
#   scripts/db-refresh.sh --dry-run        # print the steps without running them
#   scripts/db-refresh.sh --skip-verify    # refresh, then skip the post-seed checks
#
# Overridable env vars (defaults match hive-os-infra/docker-compose.yml):
#   COMPOSE_FILE     docker-compose.yml
#   DB_CONTAINER     hive-db
#   BACKEND_CONTAINER hive-backend
#   DB_USER          hive
#   DB_NAME          hive            (central database)
#   TENANT_PREFIX    tenant          (tenant databases are <prefix><id>)
#   APP_URL          http://localhost:8081
#
set -Eeuo pipefail

if [ "${TRACE_REFRESH:-0}" = "1" ]; then
  set -x
fi

# ── resolve repo root (this script lives in <repo>/hive-os-infra/scripts) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${INFRA_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE="docker compose -f ${COMPOSE_FILE}"
DB_CONTAINER="${DB_CONTAINER:-hive-db}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-hive-backend}"
DB_USER="${DB_USER:-hive}"
DB_NAME="${DB_NAME:-hive}"
TENANT_PREFIX="${TENANT_PREFIX:-tenant}"
APP_URL="${APP_URL:-http://localhost:8081}"

CONFIRM=0
TENANTS_ONLY=0
DRY_RUN=0
SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)        CONFIRM=1 ;;
    --tenants-only)  TENANTS_ONLY=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    --skip-verify)   SKIP_VERIFY=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

psql_db() { # psql_db <database> <sql...>
  docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "$1" -v ON_ERROR_STOP=1 -c "$2"
}
psql_db_t() { # psql_db_t <database> <sql...>  (tuples only, no headers)
  docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "$1" -t -A -v ON_ERROR_STOP=1 -c "$2"
}
run() {
  if [ "${DRY_RUN}" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    printf '  > %s\n' "$*"
    "$@"
  fi
}

step() { printf '\n== %s ==\n' "$1"; }

banner() {
  cat <<EOF

  Hive OS — Database Refresh
  ==========================
  Central DB : ${DB_NAME} (user ${DB_USER}) in container ${DB_CONTAINER}
  Tenant DBs : ${TENANT_PREFIX}*   (one per tenant node)
  Compose    : ${COMPOSE_FILE}

  A refresh DESTROYS DATA: central is dropped & recreated, every tenant
  database is dropped and re-seeded. Take a dump first if you need to keep
  anything:
    docker exec ${DB_CONTAINER} pg_dump -U ${DB_USER} -d ${DB_NAME} > hive-central.dump
EOF
}

confirm_or_abort() {
  if [ "${CONFIRM}" = "1" ]; then
    return
  fi
  if [ "${DRY_RUN}" = "1" ]; then
    return
  fi
  printf '\nType "yes" to continue, anything else to abort: '
  read -r answer
  if [ "${answer}" != "yes" ]; then
    echo "Aborted."
    exit 1
  fi
}

main() {
  banner
  confirm_or_abort

  if [ "${TENANTS_ONLY}" = "1" ]; then
    step "Tenants-only mode: re-provision tenant estate, keep central app data"
    step "1. Stop long-lived workers (they hold DB connections)"
    run docker stop "${BACKEND_CONTAINER}" hive-queue hive-scheduler
    step "2. Drop every tenant database"
    run drop_tenant_databases
    step "3. Re-provision tenants (create, migrate, seed)"
    run docker start "${BACKEND_CONTAINER}"
    run wait_for_backend
    run docker exec "${BACKEND_CONTAINER}" php artisan hive:seed-tenants --force
    step "4. Bring the workers back"
    run docker start hive-queue hive-scheduler
    maybe_verify
    echo "Done."
    exit 0
  fi

  step "1. Stop long-lived workers (they hold persistent Postgres connections)"
  run docker stop "${BACKEND_CONTAINER}" hive-queue hive-scheduler

  step "2. Reset the central database (${DB_NAME})"
  run psql_db postgres "DROP DATABASE IF EXISTS ${DB_NAME};"
  run psql_db postgres "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

  step "3. Drop every tenant database (${TENANT_PREFIX}*)"
  run drop_tenant_databases

  step "4. Run central migrations"
  run docker start "${BACKEND_CONTAINER}"
  run wait_for_backend
  run docker exec "${BACKEND_CONTAINER}" php artisan migrate --force

  step "5. Run the full seed cascade"
  run docker exec "${BACKEND_CONTAINER}" php artisan db:seed --force

  step "6. Bring the workers back and verify"
  run docker start hive-queue hive-scheduler

  maybe_verify
  echo "Done."
}

drop_tenant_databases() {
  local tenants
  tenants="$(psql_db_t "${DB_NAME}" \
    "SELECT datname FROM pg_database WHERE datname LIKE '${TENANT_PREFIX}%' ORDER BY datname;")"
  if [ -z "${tenants}" ]; then
    echo "  (no tenant databases found)"
    return
  fi
  echo "  terminating lingering connections and dropping:"
  for t in ${tenants}; do
    echo "    - ${t}"
  done
  psql_db "${DB_NAME}" \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname LIKE '${TENANT_PREFIX}%';"
  for t in ${tenants}; do
    # Quote the identifier: tenant slugs are lowercase but verification/scratch
    # tenants can carry UUIDs with hyphens, which break an unquoted DROP.
    psql_db postgres "DROP DATABASE IF EXISTS \"${t}\";"
  done
}

wait_for_backend() {
  local i=0
  until docker exec "${BACKEND_CONTAINER}" php artisan about --only=environment >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -gt 60 ]; then
      echo "ERROR: backend did not come up in time" >&2
      exit 1
    fi
    sleep 5
  done
}

maybe_verify() {
  if [ "${SKIP_VERIFY}" = "1" ] || [ "${DRY_RUN}" = "1" ]; then
    return
  fi
  step "Verify"
  echo "  central table count (expect ~363):"
  docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -t -c \
    "SELECT count(*) FROM pg_tables WHERE schemaname='public';" | sed 's/^/    /'
  local tenant
  tenant="$(psql_db_t "${DB_NAME}" \
    "SELECT datname FROM pg_database WHERE datname LIKE '${TENANT_PREFIX}%' ORDER BY datname LIMIT 1;" || true)"
  if [ -n "${tenant}" ]; then
    echo "  first tenant DB (${tenant}) — table count / roles / permissions:"
    docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${tenant}" -t -A -c \
      "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public'), (SELECT count(*) FROM roles), (SELECT count(*) FROM permissions);" | sed 's/^/    /'
  else
    echo "  (no tenant databases found — check the seed output above)"
  fi
  echo "  login check (super admin):"
  curl -s -X POST "${APP_URL}/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"super@hive.os","password":"password"}' | head -c 120
  printf '\n'
}

main "$@"
