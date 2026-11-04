#!/usr/bin/env bash
#
# Build the production backend/frontend images and push them to GHCR.
# The VPS auto-deploy timer (auto-deploy.sh) then pulls the new :latest and
# redeploys within ~2 minutes — running migrate / tenants:migrate for you.
#
# Run this on a machine that HAS the source repos (your dev box), not the VPS
# (the VPS only pulls images, it has no source).
#
# Prereqs (once):
#   docker login ghcr.io -u <your-github-username>      # PAT needs write:packages
#
# Usage:
#   scripts/build-and-push.sh                # build + push BOTH
#   scripts/build-and-push.sh backend        # backend only
#   scripts/build-and-push.sh frontend       # frontend only
#
# Frontend build args (NEXT_PUBLIC_*) are baked into the bundle at build time.
# They are read from $ENV_FILE if it exists, otherwise from the environment,
# otherwise from the production defaults below.
#
set -euo pipefail

TARGET="${1:-both}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIVE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"        # dir containing the three repos
BACKEND_DIR="$HIVE_ROOT/hive-os-backend"
FRONTEND_DIR="$HIVE_ROOT/hive-os-frontend"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env.prod}"   # infra .env.prod by default

BACKEND_IMG="ghcr.io/techiveet/hive-os-backend:latest"
FRONTEND_IMG="ghcr.io/techiveet/hive-os-frontend:latest"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

build_backend() {
  log "Building backend image"
  docker build -f "$BACKEND_DIR/Dockerfile.prod" -t "$BACKEND_IMG" "$BACKEND_DIR"
  log "Pushing $BACKEND_IMG"
  docker push "$BACKEND_IMG"
}

build_frontend() {
  if [ -f "$ENV_FILE" ]; then
    log "Sourcing frontend build args from $ENV_FILE"
    set -a; # shellcheck disable=SC1090
    source "$ENV_FILE"; set +a
  else
    log "No env file at $ENV_FILE — using environment / defaults"
  fi

  # Production defaults (match docker-compose.prod.yml) when a value is unset.
  : "${NEXT_PUBLIC_ROOT_DOMAIN:=gulfingot.com}"
  : "${NEXT_PUBLIC_FRONTEND_DOMAIN:=hive.gulfingot.com}"
  : "${NEXT_PUBLIC_BACKEND_DOMAIN:=hive-backend.gulfingot.com}"
  : "${NEXT_PUBLIC_REVERB_DOMAIN:=hive-ws.gulfingot.com}"
  : "${NEXT_PUBLIC_REVERB_HOST:=hive-ws.gulfingot.com}"
  : "${NEXT_PUBLIC_REVERB_PORT:=443}"
  : "${NEXT_PUBLIC_REVERB_SCHEME:=https}"
  : "${INTERNAL_API_URL:=http://backend:8000/api/v1}"

  if [ -z "${NEXT_PUBLIC_REVERB_APP_KEY:-}" ]; then
    echo "WARNING: NEXT_PUBLIC_REVERB_APP_KEY is empty — real-time (websocket) features will not work." >&2
  fi

  log "Building frontend image"
  docker build -f "$FRONTEND_DIR/Dockerfile.prod" \
    --build-arg NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-}" \
    --build-arg NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-}" \
    --build-arg NEXT_PUBLIC_CENTRAL_DOMAINS="${NEXT_PUBLIC_CENTRAL_DOMAINS:-}" \
    --build-arg NEXT_PUBLIC_ROOT_DOMAIN="$NEXT_PUBLIC_ROOT_DOMAIN" \
    --build-arg NEXT_PUBLIC_SERVER_IP="${NEXT_PUBLIC_SERVER_IP:-}" \
    --build-arg NEXT_PUBLIC_FRONTEND_DOMAIN="$NEXT_PUBLIC_FRONTEND_DOMAIN" \
    --build-arg NEXT_PUBLIC_BACKEND_DOMAIN="$NEXT_PUBLIC_BACKEND_DOMAIN" \
    --build-arg NEXT_PUBLIC_REVERB_DOMAIN="$NEXT_PUBLIC_REVERB_DOMAIN" \
    --build-arg NEXT_PUBLIC_REVERB_APP_KEY="${NEXT_PUBLIC_REVERB_APP_KEY:-}" \
    --build-arg NEXT_PUBLIC_REVERB_HOST="$NEXT_PUBLIC_REVERB_HOST" \
    --build-arg NEXT_PUBLIC_REVERB_PORT="$NEXT_PUBLIC_REVERB_PORT" \
    --build-arg NEXT_PUBLIC_REVERB_SCHEME="$NEXT_PUBLIC_REVERB_SCHEME" \
    --build-arg INTERNAL_API_URL="$INTERNAL_API_URL" \
    --build-arg NEXT_PUBLIC_SENTRY_DSN="${NEXT_PUBLIC_SENTRY_DSN:-}" \
    --build-arg NEXT_SKIP_BUILD_TYPECHECK=1 \
    -t "$FRONTEND_IMG" "$FRONTEND_DIR"
  log "Pushing $FRONTEND_IMG"
  docker push "$FRONTEND_IMG"
}

case "$TARGET" in
  backend)  build_backend ;;
  frontend) build_frontend ;;
  both)     build_backend; build_frontend ;;
  *) echo "Usage: $0 [backend|frontend|both]" >&2; exit 1 ;;
esac

log "Done. The VPS auto-deploy timer will pull and redeploy within ~2 min."
echo "Watch on the VPS:  tail -f /root/projects/hive/storage/logs/auto-deploy.log"
echo "Verify live:       curl -s https://global-b2b.gulfingot.com/api/v1/settings/seo/public"
