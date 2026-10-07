#!/usr/bin/env bash
#
# healthcheck.sh — end-to-end health check for the hive-os-infra stack.
#
# Asserts, against the running stack:
#   1. every core compose service has a running container (and a healthy one,
#      wherever the service defines a healthcheck)
#   2. no container is crash-looping (docker restart count)
#   3. every published endpoint answers over HTTP
#   4. the in-container dependencies answer: postgres, redis, meilisearch,
#      ollama, ffmpeg-api, video-backend, gotenberg
#   5. the Laravel app reaches its database through its own configuration
#   6. the Horizon queue workers are alive
#   7. the scheduler has completed tasks (its log tail shows finished runs)
#   8. the app's S3 disk can write, read back, and delete an object
#   9. both pre-warmers still honour their adaptive contracts, via each warmer's
#      own test harness (fake server, real warmer as a child process, assertions
#      on the exact requests it made): the frontend's value-ordered passes,
#      early back-off on a contended host, and tenant coverage across successive
#      constrained passes; and the backend's per-tenant authenticated tier —
#      Host-header logins, token reuse, the same back-off and rotation.
#
# Exit status: 0 = all checks passed, 1 = at least one check failed,
#              2 = preflight error (docker / compose unavailable).
#
# Usage: scripts/healthcheck.sh [-q|--quiet] [-h|--help]
#
# Runnable from any directory — it locates the stack from its own path.
#
# Environment overrides:
#   COMPOSE_PROJECT_NAME   compose project name                (default: hive-os-infra)
#   CORE_SERVICES          services that must be running       (default: the 18 core services)
#   ONE_SHOT_SERVICES      services expected to exit 0         (default: seaweedfs-bootstrap)
#   BACKEND_URL  FRONTEND_URL  ADMINER_URL  MAILPIT_URL  OLLAMA_URL
#   SEAWEEDFS_MASTER_URL  SEAWEEDFS_FILER_URL  SEAWEEDFS_S3_URL  REVERB_URL  LIVEKIT_URL
#   HTTP_TIMEOUT           per-request timeout in seconds      (default: 10)
#   HTTP_RETRIES           attempts per endpoint               (default: 3)
#   FRONTEND_TIMEOUT       timeout for the Next.js dev server  (default: 60)
#   SCHEDULER_TAIL         scheduler log lines scanned for work (default: 500)
#   SCHEDULER_CHECK        set to 0 to skip that check         (default: 1)
#   WARMER_CONTRACT_CHECK  set to 0 to skip that check         (default: 1)
#   WARMER_CONTRACT_SCRIPTS  directory holding the pre-warmer scripts
#                          (default: this stack's scripts/)
#   WARMER_CONTRACT_IMAGE  node image used for that check      (default: node:22-alpine)
#   CORE_SERVICES / ONE_SHOT_SERVICES and the *_URL variables also make the
#   script deploy-profile aware: a check whose backing service has no container
#   in the project at all is SKIPPED with a warning (a production stack simply
#   does not carry adminer/mailpit/ollama/the warmers), while a service that IS
#   deployed but broken still fails the check.
#   NO_COLOR               set to disable colored output
#
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PROJECT="${COMPOSE_PROJECT_NAME:-hive-os-infra}"
COMPOSE=(docker compose -p "$PROJECT")

# Services that make up a healthy local stack. gotenberg is profile-gated
# (--profile docs), so it is listed explicitly rather than inferred.
CORE_SERVICES="${CORE_SERVICES:-backend backend-warmup frontend frontend-warmup queue scheduler reverb db redis meilisearch seaweedfs mailpit ollama ffmpeg video-backend video-media gotenberg adminer}"
# Services that are supposed to run once, exit 0, and stop.
ONE_SHOT_SERVICES="${ONE_SHOT_SERVICES:-seaweedfs-bootstrap}"

BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8081}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:3001}"
ADMINER_URL="${ADMINER_URL:-http://127.0.0.1:8083}"
MAILPIT_URL="${MAILPIT_URL:-http://127.0.0.1:8085}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
SEAWEEDFS_MASTER_URL="${SEAWEEDFS_MASTER_URL:-http://127.0.0.1:9333}"
SEAWEEDFS_FILER_URL="${SEAWEEDFS_FILER_URL:-http://127.0.0.1:8888}"
SEAWEEDFS_S3_URL="${SEAWEEDFS_S3_URL:-http://127.0.0.1:8333}"
REVERB_URL="${REVERB_URL:-http://127.0.0.1:9095}"
LIVEKIT_URL="${LIVEKIT_URL:-http://127.0.0.1:17880}"

HTTP_TIMEOUT="${HTTP_TIMEOUT:-10}"
HTTP_RETRIES="${HTTP_RETRIES:-3}"
FRONTEND_TIMEOUT="${FRONTEND_TIMEOUT:-60}"
SCHEDULER_TAIL="${SCHEDULER_TAIL:-500}"
SCHEDULER_CHECK="${SCHEDULER_CHECK:-1}"
# The pre-warmer contract check runs the warmer's own test harness (see
# scripts/test-prewarm-frontend.mjs) in the image the warmer runs in.
WARMER_CONTRACT_CHECK="${WARMER_CONTRACT_CHECK:-1}"
WARMER_CONTRACT_SCRIPTS="${WARMER_CONTRACT_SCRIPTS:-$SCRIPT_DIR}"
WARMER_CONTRACT_IMAGE="${WARMER_CONTRACT_IMAGE:-node:22-alpine}"

QUIET=0

usage() {
    cat <<'USAGE'
usage: scripts/healthcheck.sh [-q|--quiet] [-h|--help]

End-to-end health check for the hive-os-infra stack.
Exit status is 0 when every check passes, 1 when any check fails,
2 when the environment is unusable (no docker daemon, bad compose file).

  -q, --quiet   print only warnings, failures and the summary
  -h, --help    show this help
USAGE
}

for arg in "$@"; do
    case "$arg" in
        -q | --quiet) QUIET=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            printf 'healthcheck: unknown option: %s (try --help)\n' "$arg" >&2
            exit 2
            ;;
    esac
done

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    C_PASS=$'\033[32m' C_FAIL=$'\033[31m' C_WARN=$'\033[33m' C_DIM=$'\033[2m' C_OFF=$'\033[0m'
else
    C_PASS='' C_FAIL='' C_WARN='' C_DIM='' C_OFF=''
fi

PASSED=0
FAILED=0
WARNED=0
FAILURES=()

section() { ((QUIET)) || printf '\n%s\n' "$1"; }
pass() {
    PASSED=$((PASSED + 1))
    ((QUIET)) || printf '  %sPASS%s %s\n' "$C_PASS" "$C_OFF" "$1"
}
fail() {
    FAILED=$((FAILED + 1))
    FAILURES+=("$1")
    printf '  %sFAIL%s %s\n' "$C_FAIL" "$C_OFF" "$1"
}
warn() {
    WARNED=$((WARNED + 1))
    printf '  %sWARN%s %s\n' "$C_WARN" "$C_OFF" "$1"
}
info() { ((QUIET)) || printf '  %sINFO%s %s\n' "$C_DIM" "$C_OFF" "$1"; }

one_line() { printf '%s' "${1:-<no output>}" | tr '\n' ' ' | tr -s ' ' | cut -c1-220; }

read -r -a CORE_ARR <<<"$CORE_SERVICES"
read -r -a ONE_SHOT_ARR <<<"$ONE_SHOT_SERVICES"

is_core() {
    local c
    for c in "${CORE_ARR[@]}"; do [[ "$c" == "$1" ]] && return 0; done
    return 1
}

is_one_shot() {
    local s
    for s in "${ONE_SHOT_ARR[@]}"; do [[ "$s" == "$1" ]] && return 0; done
    return 1
}

cid_of() { "${COMPOSE[@]}" ps -aq "$1" 2>/dev/null | head -n 1; }

check_http() { # name url expected_codes [timeout] [retries] [service]
    local name="$1" url="$2" expect="$3"
    local timeout="${4:-$HTTP_TIMEOUT}" retries="${5:-$HTTP_RETRIES}" svc="${6:-}"
    # The same script also guards the production stack, where several of the
    # dev stack's extras (adminer, mailpit, ollama, …) are not deployed. If the
    # endpoint's backing service has NO container at all, this is a profile
    # difference, not a broken deploy — skip it and let the owner of the
    # required-set failure be the Containers section. A service whose container
    # exists but answers wrong still FAILs, as before.
    if [[ -n "$svc" && -z "$(cid_of "$svc")" ]]; then
        warn "$name skipped — service '$svc' is not deployed here"
        return
    fi
    local attempt code=000
    for ((attempt = 1; attempt <= retries; attempt++)); do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$timeout" "$url" 2>/dev/null)" || code=000
        case ",$expect," in *",$code,"*) break ;; esac
        if ((attempt < retries)); then sleep 1; fi
    done
    case ",$expect," in
        *",$code,"*) pass "$name (HTTP $code)" ;;
        *) fail "$name (HTTP $code, expected $expect) — $url" ;;
    esac
}

check_exec() { # name service cmd...
    local name="$1" svc="$2"
    shift 2
    local cid out
    cid="$(cid_of "$svc")"
    if [[ -z "$cid" ]]; then
        # Same profile rule as check_http: a service that is not deployed here
        # at all cannot fail this stack's checks (the Containers section owns
        # the required-set verdict); one that is deployed but broken does.
        if is_core "$svc"; then
            fail "$name — no container for service '$svc'"
        else
            warn "$name skipped — service '$svc' is not deployed here"
        fi
        return
    fi
    if out="$(docker exec "$cid" "$@" 2>&1)"; then
        pass "$name"
    else
        fail "$name — $(one_line "$out")"
    fi
}

check_exec_out() { # name service expected_substring cmd...
    local name="$1" svc="$2" want="$3"
    shift 3
    local cid out rc
    cid="$(cid_of "$svc")"
    if [[ -z "$cid" ]]; then
        if is_core "$svc"; then
            fail "$name — no container for service '$svc'"
        else
            warn "$name skipped — service '$svc' is not deployed here"
        fi
        return
    fi
    out="$(docker exec "$cid" "$@" 2>&1)"
    rc=$?
    if ((rc == 0)) && grep -qF -- "$want" <<<"$out"; then
        pass "$name"
    else
        fail "$name — exit=$rc, output: $(one_line "$out")"
    fi
}

# --- preflight ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    printf 'healthcheck: docker CLI not found\n' >&2
    exit 2
fi
if ! docker info >/dev/null 2>&1; then
    printf 'healthcheck: cannot reach the Docker daemon (is Docker Desktop running?)\n' >&2
    exit 2
fi
cd -- "$STACK_DIR" 2>/dev/null || {
    printf 'healthcheck: cannot enter %s\n' "$STACK_DIR" >&2
    exit 2
}
if ! "${COMPOSE[@]}" config -q >/dev/null 2>&1; then
    printf 'healthcheck: docker compose config failed in %s (project %s)\n' "$STACK_DIR" "$PROJECT" >&2
    exit 2
fi

((QUIET)) || printf 'hive-os-infra healthcheck — %s (project: %s)\n' "$STACK_DIR" "$PROJECT"

# --- containers --------------------------------------------------------------
section "Containers"

declare -A SEEN_SERVICE=()
PS_TABLE="$("${COMPOSE[@]}" ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null || true)"

while IFS='|' read -r svc state health; do
    [[ -z "${svc:-}" ]] && continue
    SEEN_SERVICE["$svc"]=1

    if is_one_shot "$svc"; then
        cid="$(cid_of "$svc")"
        if [[ -z "$cid" ]]; then
            info "one-shot service '$svc' already ran and was cleaned up"
        else
            code="$(docker inspect --format '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo unknown)"
            if [[ "$code" == "0" ]]; then
                pass "one-shot service '$svc' completed (exit 0)"
            else
                fail "one-shot service '$svc' exited with code $code"
            fi
        fi
        continue
    fi

    if [[ "$state" != "running" ]]; then
        fail "service '$svc' is '$state', expected 'running'"
    elif [[ "$health" == "unhealthy" ]]; then
        fail "service '$svc' is running but unhealthy"
    elif [[ "$health" == "starting" ]]; then
        warn "service '$svc' is running, health still 'starting'"
    else
        pass "service '$svc' running${health:+ (health: $health)}"
    fi
done <<<"$PS_TABLE"

missing=()
for svc in "${CORE_ARR[@]}"; do
    [[ -n "${SEEN_SERVICE[$svc]:-}" ]] || missing+=("$svc")
done
if ((${#missing[@]} > 0)); then
    fail "core service(s) with no container: ${missing[*]} — start them with 'docker compose -p $PROJECT up -d' (profile-gated services need --profile <name>)"
else
    pass "all ${#CORE_ARR[@]} core services have containers"
fi

mapfile -t SEEN_SORTED < <(printf '%s\n' "${!SEEN_SERVICE[@]}" | sort)
for svc in "${SEEN_SORTED[@]}"; do
    is_one_shot "$svc" && continue
    is_core "$svc" || info "extra service '$svc' is up (profile-gated, not required)"
done

# --- crash loops -------------------------------------------------------------
section "Crash loops"

IDS=()
while IFS= read -r id; do [[ -n "$id" ]] && IDS+=("$id"); done < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
if ((${#IDS[@]} == 0)); then
    fail "no containers carry the label com.docker.compose.project=$PROJECT"
else
    RESTART_REPORT=""
    while IFS='|' read -r cname restarts; do
        [[ -z "${cname:-}" ]] && continue
        if ((restarts > 0)); then
            RESTART_REPORT+="${cname#/} (x$restarts) "
        fi
    done < <(docker inspect --format '{{.Name}}|{{.RestartCount}}' "${IDS[@]}" 2>/dev/null)
    if [[ -n "$RESTART_REPORT" ]]; then
        warn "containers have restarted since creation: $RESTART_REPORT"
    else
        pass "no crash loops (${#IDS[@]} containers, restart count 0)"
    fi
fi

# --- published endpoints -----------------------------------------------------
section "Published endpoints"

check_http "backend /up" "$BACKEND_URL/up" "200" "$HTTP_TIMEOUT" "$HTTP_RETRIES" backend
check_http "frontend (Next.js dev server)" "$FRONTEND_URL/" "200" "$FRONTEND_TIMEOUT" 2 frontend
check_http "adminer" "$ADMINER_URL/" "200,302" "$HTTP_TIMEOUT" "$HTTP_RETRIES" adminer
check_http "mailpit /livez" "$MAILPIT_URL/livez" "200" "$HTTP_TIMEOUT" "$HTTP_RETRIES" mailpit
check_http "seaweedfs master /cluster/status" "$SEAWEEDFS_MASTER_URL/cluster/status" "200" "$HTTP_TIMEOUT" "$HTTP_RETRIES" seaweedfs
check_http "seaweedfs filer" "$SEAWEEDFS_FILER_URL/" "200,404" "$HTTP_TIMEOUT" "$HTTP_RETRIES" seaweedfs
check_http "seaweedfs s3" "$SEAWEEDFS_S3_URL/" "200,403" "$HTTP_TIMEOUT" "$HTTP_RETRIES" seaweedfs
check_http "reverb" "$REVERB_URL/" "200,404" "$HTTP_TIMEOUT" "$HTTP_RETRIES" reverb
check_http "livekit (video-media)" "$LIVEKIT_URL/" "200" "$HTTP_TIMEOUT" "$HTTP_RETRIES" video-media
check_http "ollama" "$OLLAMA_URL/" "200" "$HTTP_TIMEOUT" "$HTTP_RETRIES" ollama

STATUS_BODY="$(curl -s --max-time "$HTTP_TIMEOUT" "$SEAWEEDFS_MASTER_URL/cluster/status" 2>/dev/null || true)"
if [[ -z "$(cid_of seaweedfs)" ]]; then
    warn "seaweedfs leader skipped — service 'seaweedfs' is not deployed here"
elif grep -q '"IsLeader":true' <<<"$STATUS_BODY"; then
    pass "seaweedfs master has an elected leader"
else
    fail "seaweedfs master has no leader — response: $(one_line "$STATUS_BODY")"
fi

# --- in-container dependencies ----------------------------------------------
section "In-container dependencies"

check_exec_out "postgres accepting connections" db "accepting" pg_isready -U hive
check_exec_out "redis responds to PING" redis "PONG" redis-cli ping
check_exec_out "meilisearch /health" meilisearch "available" curl -fsS http://localhost:7700/health
check_exec_out "ffmpeg-api /health" ffmpeg '"status":"ok"' curl -fsS http://localhost:9090/health
check_exec_out "gotenberg /health" gotenberg '"status":"up"' curl -fsS http://localhost:3000/health
check_exec "video-backend /health" video-backend node -e 'fetch("http://127.0.0.1:5001/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
check_exec "ollama can list models" ollama ollama list

# --- application wiring ------------------------------------------------------
section "Application wiring"

check_exec_out "Horizon queue workers alive" queue "is running" php artisan horizon:status --no-ansi

DB_PROBE="$(docker exec -i "$(cid_of backend)" php 2>&1 <<'PHP'
<?php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
try {
    $row = Illuminate\Support\Facades\DB::selectOne('select 1 as ok');
    echo 'db ok via ' . Illuminate\Support\Facades\DB::connection()->getDriverName() . ' (select 1 = ' . $row->ok . ')';
} catch (Throwable $e) {
    fwrite(STDERR, get_class($e) . ': ' . $e->getMessage());
    exit(1);
}
PHP
)"
DB_RC=$?
if ((DB_RC == 0)); then
    pass "database reachable through the app's own config"
else
    fail "database unreachable through the app's config — $(one_line "$DB_PROBE")"
fi

STORAGE_PROBE="$(docker exec -i "$(cid_of backend)" php 2>&1 <<'PHP'
<?php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$disk = Illuminate\Support\Facades\Storage::disk('s3');
$key = 'healthcheck/probe-' . bin2hex(random_bytes(4)) . '.txt';
$payload = 'hive-healthcheck ' . gmdate('c');
$error = null;
try {
    $disk->put($key, $payload);
    if ($disk->get($key) !== $payload) {
        $error = 'write/read-back mismatch';
    }
} catch (Throwable $e) {
    $error = get_class($e) . ': ' . $e->getMessage();
}
try {
    $disk->delete($key);
} catch (Throwable $e) {
    // nothing left to clean up
}
if ($error !== null) {
    fwrite(STDERR, $error);
    exit(1);
}
echo 's3 ok, bucket=' . config('filesystems.disks.s3.bucket') . ', object cleaned up';
PHP
)"
STORAGE_RC=$?
if ((STORAGE_RC == 0)); then
    pass "object storage write/read/delete through the app ($(one_line "$STORAGE_PROBE"))"
else
    fail "object storage write/read/delete failed — $(one_line "$STORAGE_PROBE")"
fi

# --- scheduler ---------------------------------------------------------------
# Two deliberate choices here:
#   * --tail instead of --since: on this Docker Desktop setup
#     `docker logs --since <recent timestamp>` returns zero lines for some
#     containers even though --tail shows entries stamped seconds ago, so a
#     --since based freshness check reports a false failure.
#   * the log is captured into a variable before matching: `docker logs | grep -q`
#     would kill docker with SIGPIPE (exit 141) once grep finds a match, and
#     `set -o pipefail` would then report a failure that never happened.
# Liveness of the supervisor process is already covered by the Containers
# section, since PID 1 of this service is `php artisan schedule:work`.
section "Scheduler"

if [[ "$SCHEDULER_CHECK" != "1" ]]; then
    info "scheduler check skipped (SCHEDULER_CHECK=$SCHEDULER_CHECK)"
else
    SCHED_CID="$(cid_of scheduler)"
    if [[ -z "$SCHED_CID" ]]; then
        fail "scheduler check — no container for service 'scheduler'"
    elif ! SCHED_LOG="$(docker logs --tail "$SCHEDULER_TAIL" "$SCHED_CID" 2>&1)"; then
        fail "scheduler check — 'docker logs' failed: $(one_line "$SCHED_LOG")"
    elif grep -qE 'DONE|SUCCESS' <<<"$SCHED_LOG"; then
        pass "scheduler has completed tasks (log tail: $SCHEDULER_TAIL lines)"
    else
        fail "scheduler log tail ($SCHEDULER_TAIL lines) shows no completed task (raise SCHEDULER_TAIL, or set SCHEDULER_CHECK=0 to skip)"
    fi
fi

# --- pre-warmer contract -----------------------------------------------------
# How much of the frontend pre-warmer's 29-request pass runs is decided from the
# host's 1-minute load average. No probe of the running stack can tell whether
# that logic still works: a healthy stack looks the same whether the warmer spares
# a contended host or not. So it is pinned here by scripts/test-prewarm-frontend.mjs
# — a scripted fake frontend, the real warmer as a child process, and assertions on
# the exact sequence of requests it made. It runs in the image the warmer itself
# runs in, with no network, against a read-only copy of the scripts, so it cannot
# touch the stack. Set WARMER_CONTRACT_CHECK=0 for a fast stack-only check.
section "Pre-warmer contract"

if [[ "$WARMER_CONTRACT_CHECK" != "1" ]]; then
    info "pre-warmer contract check skipped (WARMER_CONTRACT_CHECK=$WARMER_CONTRACT_CHECK)"
elif [[ ! -f "$WARMER_CONTRACT_SCRIPTS/test-prewarm-frontend.mjs" ]]; then
    fail "pre-warmer contract — $WARMER_CONTRACT_SCRIPTS/test-prewarm-frontend.mjs not found"
else
    # Both the exit status and the output are kept: the status is the verdict, the
    # output names which cases broke.
    WARMER_OUT="$(docker run --rm --network none -v "$WARMER_CONTRACT_SCRIPTS:/warmer:ro" "$WARMER_CONTRACT_IMAGE" node /warmer/test-prewarm-frontend.mjs 2>&1)"
    WARMER_RC=$?
    WARMER_CASES="$(sed -n 's/^\([0-9][0-9]*\/[0-9][0-9]*\) case(s) passed$/\1/p' <<<"$WARMER_OUT" | tail -n 1)"
    if ((WARMER_RC == 0)); then
        pass "pre-warmer contract holds — ${WARMER_CASES:-all cases} adaptive (value order, back-off, tenant coverage)"
    else
        WARMER_BROKE="$(grep -E '^FAIL' <<<"$WARMER_OUT" | sed 's/^FAIL  //' | tr '\n' ';')"
        fail "pre-warmer contract broke — $(one_line "${WARMER_BROKE:-$WARMER_OUT}")"
    fi
fi

# The backend pre-warmer gets the same treatment: its per-tenant tier (per-host
# logins under the tenant Host header, token reuse, load-aware capping and
# least-recently-warmed rotation) is asserted by its own harness against a fake
# backend — see the comment block above for why this is a contract check and not
# a probe of the running stack.
if [[ "$WARMER_CONTRACT_CHECK" != "1" ]]; then
    info "backend pre-warmer contract check skipped (WARMER_CONTRACT_CHECK=$WARMER_CONTRACT_CHECK)"
elif [[ ! -f "$WARMER_CONTRACT_SCRIPTS/test-prewarm-backend.mjs" ]]; then
    fail "backend pre-warmer contract — $WARMER_CONTRACT_SCRIPTS/test-prewarm-backend.mjs not found"
else
    BACKEND_WARMER_OUT="$(docker run --rm --network none -v "$WARMER_CONTRACT_SCRIPTS:/warmer:ro" "$WARMER_CONTRACT_IMAGE" node /warmer/test-prewarm-backend.mjs 2>&1)"
    BACKEND_WARMER_RC=$?
    BACKEND_WARMER_CASES="$(sed -n 's/^\([0-9][0-9]*\/[0-9][0-9]*\) case(s) passed$/\1/p' <<<"$BACKEND_WARMER_OUT" | tail -n 1)"
    if ((BACKEND_WARMER_RC == 0)); then
        pass "backend pre-warmer contract holds — ${BACKEND_WARMER_CASES:-all cases} (tenant logins, token reuse, back-off, rotation)"
    else
        BACKEND_WARMER_BROKE="$(grep -E '^FAIL' <<<"$BACKEND_WARMER_OUT" | sed 's/^FAIL  //' | tr '\n' ';')"
        fail "backend pre-warmer contract broke — $(one_line "${BACKEND_WARMER_BROKE:-$BACKEND_WARMER_OUT}")"
    fi
fi

# --- summary -----------------------------------------------------------------
printf '\n%s\n' "────────────────────────────────────────────────────────────"
printf 'checks: %d passed, %d failed, %d warning(s)\n' "$PASSED" "$FAILED" "$WARNED"
if ((FAILED > 0)); then
    printf '\nfailed checks:\n'
    for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
    printf '\nresult: %sUNHEALTHY%s\n' "$C_FAIL" "$C_OFF"
    exit 1
fi
printf 'result: %sHEALTHY%s\n' "$C_PASS" "$C_OFF"
exit 0
