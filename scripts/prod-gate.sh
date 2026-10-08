#!/usr/bin/env bash
#
# prod-gate.sh — run the stack healthcheck gate against the Coolify-managed
# production VPS stack. Run it ON the VPS:
#
#     ssh root@<vps> 'bash -s' < scripts/prod-gate.sh
#     # or, in the Coolify checkout:
#     bash scripts/prod-gate.sh [-q]
#
# Why this exists: deploy-prod.sh's gate targets the legacy manual deployment
# (docker-compose.prod.yml, retired hive-caddy, host-published ports).
# Production now runs entirely from Coolify (docs/coolify-production.md), which
# changes everything the gate used to take for granted:
#
#   - the compose project is the Coolify app uuid, not the checkout's name
#   - the stack is created from docker-compose.prod.vps.yml plus a GENERATED
#     .env (required variables live in Coolify, not in a committed file)
#   - the edge is coolify-proxy, which is not a service of this compose project
#   - seaweedfs/reverb/meilisearch publish no host ports; they are reached
#     through the proxy domains or from inside their containers
#
# So the required set is DERIVED from the compose file itself (every
# non-profile service except the one-shots), the compose file + env file come
# from the running containers' own labels, and the endpoints that have no
# host-reachable address are skipped in favour of in-container checks.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HC="$SCRIPT_DIR/healthcheck.sh"
[[ -f "$HC" ]] || { echo "prod-gate: $HC not found" >&2; exit 2; }

PROJ_LABEL="com.docker.compose.project"
CONF_LABEL="com.docker.compose.project.config_files"
ENV_LABEL="com.docker.compose.project.environment_file"

# --- 1. find the hive stack through its compose file label -------------------
# docker-compose.prod.vps.yml is unique to this app on the host, so a container
# carrying it in the config_files label identifies the hive project even when
# every other app on the box also has a service literally called "backend".
STACK_CID=""
for id in $(docker ps -q); do
    cf="$(docker inspect "$id" --format "{{index .Config.Labels \"$CONF_LABEL\"}}" 2>/dev/null)" || continue
    case "$cf" in
        *docker-compose.prod.vps.yml*) STACK_CID="$id"; break ;;
    esac
done
if [[ -z "$STACK_CID" ]]; then
    echo "prod-gate: no running container was created from docker-compose.prod.vps.yml — is the stack up?" >&2
    exit 2
fi

PROJECT="$(docker inspect "$STACK_CID" --format "{{index .Config.Labels \"$PROJ_LABEL\"}}")"
COMPOSE_FILES="$(docker inspect "$STACK_CID" --format "{{index .Config.Labels \"$CONF_LABEL\"}}" | tr ':' ' ')"
ENV_FILE="$(docker inspect "$STACK_CID" --format "{{index .Config.Labels \"$ENV_LABEL\"}}")"
echo "prod-gate: project=$PROJECT compose=$COMPOSE_FILES env=$ENV_FILE"

# --- 2. required set = non-profile services minus the one-shots ---------------
# Read straight from the stack's own definition, so a service added to
# docker-compose.prod.vps.yml is required by the next gate run automatically.
ONE_SHOT_SERVICES="${ONE_SHOT_SERVICES:-seaweedfs-bootstrap}"
mapfile -t ALL_SERVICES < <(
    COMPOSE_PROFILES="" docker compose -p "$PROJECT" -f $COMPOSE_FILES --env-file "$ENV_FILE" config --services 2>/dev/null | sort
)
if ((${#ALL_SERVICES[@]} == 0)); then
    echo "prod-gate: could not list services from the compose file" >&2
    exit 2
fi
CORE_SERVICES=""
for svc in "${ALL_SERVICES[@]}"; do
    keep=1
    for one in $ONE_SHOT_SERVICES; do [[ "$svc" == "$one" ]] && keep=0; done
    ((keep)) && CORE_SERVICES+="$svc "
done

# --- 3. endpoints: only the ones with a host-reachable address ---------------
BACKEND_URL="${BACKEND_URL:-https://hive-backend.gulfingot.com}"
FRONTEND_URL="${FRONTEND_URL:-https://hive.gulfingot.com}"
REVERB_URL="${REVERB_URL:-https://hive-ws.gulfingot.com}"
# seaweedfs publishes no host ports on Coolify; its leader check probes the
# master from inside the container instead (healthcheck.sh handles that).
# livekit/video URLs are likewise proxy-only, and the dev defaults would just
# answer 000 from the host. Empty = skip the HTTP check, container + exec own it.
SEAWEEDFS_MASTER_URL="${SEAWEEDFS_MASTER_URL:-}"
SEAWEEDFS_FILER_URL="${SEAWEEDFS_FILER_URL:-}"
SEAWEEDFS_S3_URL="${SEAWEEDFS_S3_URL:-}"
LIVEKIT_URL="${LIVEKIT_URL:-}"

# --- 4. run the gate ----------------------------------------------------------
export COMPOSE_PROJECT_NAME="$PROJECT"
export COMPOSE_FILE="$COMPOSE_FILES"
export COMPOSE_ENV_FILE="$ENV_FILE"
export CORE_SERVICES ONE_SHOT_SERVICES
export BACKEND_URL FRONTEND_URL REVERB_URL
export SEAWEEDFS_MASTER_URL SEAWEEDFS_FILER_URL SEAWEEDFS_S3_URL LIVEKIT_URL

# Tolerate a leading `--` (e.g. `ssh host "bash -s -- -q" < prod-gate.sh`, where
# bash -s turns the first argument into $0) — forward only real flags to the
# healthcheck.
ARGS=()
for _arg in "$@"; do
    if (( ${#ARGS[@]} == 0 )) && [[ "$_arg" == "--" ]]; then continue; fi
    ARGS+=("$_arg")
done
exec bash "$HC" "${ARGS[@]}"
