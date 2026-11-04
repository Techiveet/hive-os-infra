#!/usr/bin/env bash
# Measures what the backend pre-warmer is actually worth, in three parts.
#
# Run from the repo root:  ./scripts/measure-backend-warmup.sh
# Knobs: SAMPLES (default 3), GAP seconds (default 12), PHASES (any of 1, 2, 3,
#        comma-free subsets: "12" = 1+2 as before, default "123" = all).
#
# PHASE 1 -- isolated worker bootstrap, separated from the entrypoint's background
#   `laradocs:index` rebuild. A throwaway container is started from the same image,
#   bind mount and env as `hive-backend` with the entrypoint replaced, so the index
#   rebuild never runs, there is no DB wait and no compose healthcheck probing /up.
#   Nothing is on the clock except the app booting inside the RoadRunner workers.
#
#   Readiness is detected WITHOUT issuing an HTTP request (listening socket only),
#   because a /up probe would itself boot a worker and destroy the cold sample.
#   Requests are timed INSIDE the container so host-side exec and port-forwarding
#   overhead never land in the numbers.
#
#   A cold burst of 6 concurrent requests boots the whole pool (this stack runs 5
#   workers); a second burst is the warm baseline. The gap is the bootstrap cost.
#
# PHASE 2 -- the real stack: the first request a user makes after a backend restart,
#   with the warmer stopped vs running. The burst is fired as soon as a worker
#   process exists and is measured inside the container. The point is to test
#   whether the warmer is actually ahead of the user, not merely whether it exists.
#
# PHASE 3 -- the same question for the PER-TENANT surface. A tenant's first
#   request after a restart pays TWO things the central tiers never touch:
#   the worker bootstrap on the tenant-authenticated code path, and the tenant
#   context itself (InitializeTenantContext, the tenant DB connection, the
#   tenant's module/subscription lookups). The central numbers above cannot see
#   either. So: a tenant token is minted ONCE up front (Sanctum tokens are DB
#   rows — they survive restarts, so the login is never in the measured path,
#   exactly like PHASE 2's central token), and after each restart the FIRST
#   requests measured are the tenant tier itself — every TENANT_ROUTES route
#   for the same host, walked serially in knob order (the tier's real pass rule
#   is per-route LRU across hosts; serial per route is the robust proxy for a
#   single host). GAP later, the same walk is the warm baseline. "Off" reps
#   run with the warmer stopped; "on" reps race it — the warmer is started
#   BEFORE the restart and so is measuring whether the tier (as deployed in
#   the compose stack) also beats the user on the tenant path, the same race
#   PHASE 2 already embraces for the central path. Warmer off vs on vs forced,
#   as in PHASE 2.
#
#   Per-route output: for each route, cold and warm min/median/max per
#   condition, plus the "tier win" per walk = cold − warm for the SAME walk
#   (its GAP-later sibling). Off-rep wins are the cost the warmer could have
#   saved; on-rep wins near zero mean the warmer really did get there first.
#
#   Tenant knobs: TENANT_HOST (default lanouveil.localhost), TENANT_EMAIL
#   (default admin@<host-without-.localhost>.com — TenantUsersSeeder's rule;
#   techive has no such admin, set TENANT_EMAIL explicitly for it),
#   TENANT_PASSWORD (default "password"). Routes come from TENANT_ROUTES
#   (default "dashboard runtime"); TENANT_ROUTE is still honored as a
#   single-route override equivalent.
#
# Historical reference on this box when quiet: cold ~1.19s, warm ~12ms. Contention
# inflates both, so always report the load the numbers were taken under.
#
# PHASE 3 CAVEAT — read before quoting its numbers: the off/on comparison leans
# on the warmer having finished its pass by the time the restart fires. The
# tenant tier back-fills under WARMUP_TENANT_LOAD_BACKOFF, so on a BUSY box the
# 'on' reps may have warmed few or no tenant routes before the restart, and
# PHASE 3 then shows the tier's worst case, not its steady-state win. On this
# box the 1-minute load has been seen swinging 6.6 -> 19.8 BETWEEN reps, which
# turns off/on into noise (a warm burst measured 35s at load 19.8). Quiet-box
# numbers (the reference above was taken at load <1) are the comparable ones;
# always quote the load next to a PHASE 3 number.
#
# QUIET-BOX PHASE 3 REFERENCE — clean off/on comparison, 2026-10-08, 64-core dev
# box, tier = dashboard + runtime on lanouveil.localhost, SAMPLES=2 GAP=8, two
# runs (per-rep 1-min load in parens; both runs' shapes agreed, so both quoted):
#   off   (warmer stopped)           cold 1309ms (1.03) / 1555ms (1.73)   warm 808ms / 942ms
#   on    (warmer racing)            cold 2271ms (1.03) / 2466ms (2.01)   warm 316ms / 444ms
#   forced (warmer restarted first)  cold  987ms (2.94) / 1430ms (2.40)   warm 363ms / 375ms
# Reading, stable across all five walks of both runs: on an idle box the tenant
# tier's cold-start premium is ~0.5-0.9s (off per-walk wins 501/682/889/584ms),
# dominated by worker bootstrap + tenant context, not route caches. The racing
# warmer does NOT beat the user to the first walk — on-cold is consistently
# ~1s SLOWER than off-cold (its own 2-concurrent pass queues ahead of the user);
# only the GAP-later walk is warm (316-444ms, vs 808-942ms with the warmer off).
# forced — warmer restarted first, its fresh pass already done — gives the
# fastest first walk despite running at the highest load. Quoting rule stands:
# report the load beside any PHASE 3 number.
set -u

cd "$(dirname "$0")/.." || exit 1

HOST=http://127.0.0.1:8081
C=hive-backend
W=hive-backend-warmup
PROBE=hive-backend-probe
IMAGE=hive-os-infra-backend
NET=hive-os-infra_hive-network
CODE=$(cd ../hive-os-backend && pwd)
STORAGE=hive-os-infra_hive-backend-storage
ENVFILE=/tmp/warmup-probe.env
INTERVAL_REQUEST=/api/v1/settings/general/runtime

# PHASE 3 knobs. The email default mirrors TenantUsersSeeder: admin@<tenant-id>.com.
TENANT_HOST=${TENANT_HOST:-lanouveil.localhost}
TENANT_EMAIL=${TENANT_EMAIL:-admin@${TENANT_HOST%.localhost}.com}
TENANT_PASSWORD=${TENANT_PASSWORD:-password}
TENANT_ROUTE=${TENANT_ROUTE:-/api/v1/dashboard}
# Whole-tier knob (alias accepted by habit): "dashboard runtime" is the two
# warm-tier routes; a single route shrinks the tier to the pre-two-route size.
TENANT_ROUTES=${TENANT_ROUTES:-dashboard runtime}

# Translate the human knob into concrete URL paths.
tenant_path() {
  case "$1" in
    dashboard) echo "/api/v1/dashboard" ;;
    runtime)   echo "/api/v1/settings/general/runtime" ;;
    *)         echo "$1" ;;  # a literal path is also accepted
  esac
}
TENANT_PATHS=$(for r in $TENANT_ROUTES; do tenant_path "$r"; done | tr '\n' ' ' | sed 's/ $//')

SAMPLES=${SAMPLES:-3}
GAP=${GAP:-12}
PHASES=${PHASES:-123}

# Phase selector: "123" (default) = all, "12" = the historical two phases, "3" =
# tenant tier only, "1"/"2" = single phase as before. Phases are single digits,
# so a substring match is exact.
want() { case "$PHASES" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

workers() {
  docker exec "$1" sh -c 'ps -eo args | grep -c "[r]oadrunner-worker" 2>/dev/null || echo 0' \
    | head -1 | tr -dc '0-9'
}
listening() {
  docker exec "$1" sh -c 'netstat -ltn 2>/dev/null | grep -q ":8000" && echo yes || echo no' 2>/dev/null || echo no
}
burst() {
  docker exec "$1" sh -c '
    for i in 1 2 3 4 5 6; do
      curl -s -o /dev/null -w "%{time_total}\n" -m 120 http://127.0.0.1:8000/up &
    done
    wait' | sort -rn | tr '\n' ' '
}
load() { cut -d' ' -f1-3 /proc/loadavg; }

# The warmer must never be left stopped, however this script exits.
restore_warmer() { docker start "$W" >/dev/null 2>&1; }
trap restore_warmer EXIT

echo "== backend warmup measurement $(date -u +%H:%M:%S) =="
echo "   load: $(load)   mem: $(free -m | awk '/Mem:/{print $3"/"$2" MiB"}')  swap: $(free -m | awk '/Swap:/{print $3}') MiB"

if want 1; then
  docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -v '^HOSTNAME=' > "$ENVFILE"

  echo
  echo "=== PHASE 1: isolated worker bootstrap (entrypoint bypassed, no index rebuild) ==="
  cold_all=""; warm_all=""
  for s in $(seq 1 "$SAMPLES"); do
    docker rm -f "$PROBE" >/dev/null 2>&1
    tstart=$(date +%s)
    docker run -d --name "$PROBE" --network "$NET" --no-healthcheck \
      --env-file "$ENVFILE" \
      -v "$CODE":/var/www/html \
      -v "$STORAGE":/var/www/html/storage \
      -w /var/www/html \
      --entrypoint sh "$IMAGE" \
      -c 'exec php artisan octane:start --server=roadrunner --host=0.0.0.0 --port=8000' \
      >/dev/null 2>&1

    ready=""
    for i in $(seq 1 150); do
      if [ "$(listening "$PROBE")" = yes ]; then ready=$(( $(date +%s) - tstart )); break; fi
      sleep 1
    done
    if [ -z "$ready" ]; then
      echo "   sample $s: never listened on :8000; container log:"
      docker logs --tail 15 "$PROBE" 2>&1 | sed 's/^/      /'
      docker rm -f "$PROBE" >/dev/null 2>&1
      continue
    fi

    w=$(workers "$PROBE")
    cold=$(burst "$PROBE")
    sleep "$GAP"
    warm=$(burst "$PROBE")
    echo "   sample $s  load=$(cut -d' ' -f1 /proc/loadavg)  workers=$w  listening after ${ready}s"
    echo "      cold burst (x6 concurrent): ${cold}"
    echo "      warm burst (same workers) : ${warm}"
    echo "      laradocs:index processes in probe: $(docker exec "$PROBE" sh -c 'ps -eo args | grep -c "[l]aradocs:index"' 2>/dev/null)"
    cold_all="$cold_all $cold"
    warm_all="$warm_all $warm"
    docker rm -f "$PROBE" >/dev/null 2>&1
  done

  echo
  echo "   --- PHASE 1 summary (min is the contention-robust estimate) ---"
  echo "   cold s  min/median/max: $(printf '%s\n' $cold_all | sort -n | awk '{a[NR]=$1} END{printf "%.3f / %.3f / %.3f (n=%d)", a[1], a[int((NR+1)/2)], a[NR], NR}')"
  echo "   warm s  min/median/max: $(printf '%s\n' $warm_all | sort -n | awk '{a[NR]=$1} END{printf "%.3f / %.3f / %.3f (n=%d)", a[1], a[int((NR+1)/2)], a[NR], NR}')"
  echo "   cold/warm ratio at the minimum: $(awk -v c="$(printf '%s\n' $cold_all | sort -n | head -1)" -v w="$(printf '%s\n' $warm_all | sort -n | head -1)" 'BEGIN{if (w>0) printf "%.0fx", c/w; else print "n/a"}')"
  echo "   (the entrypoint's index rebuild cannot be in these numbers: the entrypoint is bypassed,"
  echo "    and 'laradocs:index' process count is 0 throughout)"
fi

if want 2; then
  echo
  echo "=== PHASE 2: first user burst after a real backend restart ==="
  TOKEN=$(curl -s -m 180 -X POST -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -d '{"email":"super@hive.os","password":"password"}' "$HOST/api/v1/login" | jq -r '.data.token // empty')
  if [ -z "$TOKEN" ]; then echo "   login failed - skipping PHASE 2"; else
  echo "   auth token: ${#TOKEN} chars (minted before any restart, so login is not in the measured path)"

  run_cond() {
    cond="$1"; rep="$2"
    case "$cond" in
      off) docker stop "$W" >/dev/null 2>&1 ;;
      on)  docker start "$W" >/dev/null 2>&1; sleep 1 ;;
      forced) docker start "$W" >/dev/null 2>&1 ;;
    esac

    docker restart "$C" >/dev/null
    tstart=$(date +%s); w=0
    for i in $(seq 1 150); do
      w=$(workers "$C"); [ -n "$w" ] && [ "$w" -ge 1 ] 2>/dev/null && break
      sleep 1
    done
    ready=$(( $(date +%s) - tstart ))
    [ "$cond" = forced ] && docker restart "$W" >/dev/null 2>&1

    first=$(burst "$C")
    authed=$(docker exec -e TOK="$TOKEN" "$C" sh -c \
      "curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 180 -H 'Accept: application/json' -H 'Authorization: Bearer \$TOK' http://127.0.0.1:8000$INTERVAL_REQUEST")
    echo "   rep $rep / warmer $cond  (load=$(cut -d' ' -f1 /proc/loadavg), $w workers after ${ready}s)"
    echo "      first burst /up x6: ${first}"
    echo "      first authenticated call: ${authed}"
    echo "      index rebuild procs: $(docker exec "$C" sh -c 'ps -eo args | grep -c "[l]aradocs:index"' 2>/dev/null)"
  }

  for rep in 1 2; do
    run_cond off "$rep"
    run_cond on "$rep"
  done
  run_cond forced 1
  fi
fi

if want 3; then
  echo
  echo "=== PHASE 3: first TENANT tier walk after a real backend restart ($TENANT_HOST) ==="
  TTOKEN=$(curl -s -m 180 -X POST -H 'Accept: application/json' -H 'Content-Type: application/json' \
    -H "Host: $TENANT_HOST" \
    -d "{\"email\":\"$TENANT_EMAIL\",\"password\":\"$TENANT_PASSWORD\",\"device_name\":\"warmup-measure\"}" \
    "$HOST/api/v1/tenant/login" | jq -r '.data.token // empty')
  if [ -z "$TTOKEN" ]; then
    echo "   tenant login failed for $TENANT_EMAIL - skipping PHASE 3 (check TENANT_HOST/TENANT_EMAIL; techive needs TENANT_EMAIL=mikiyas.aemero@techive.com)"
  else
  echo "   tenant token for $TENANT_EMAIL: ${#TTOKEN} chars (minted before any restart, so login is not in the measured path)"
  NROUTES=$(echo $TENANT_PATHS | wc -w)
  echo "   tier walk: $NROUTES route(s) on $TENANT_HOST, serial in knob order — $TENANT_PATHS"

  # One tier walk: every configured route once, serially, in knob order,
  # emitting one 'status seconds' line per route.
  tenant_walk() {
    for P in $TENANT_PATHS; do
      docker exec -e TOK="$TTOKEN" -e H="$TENANT_HOST" -e R="$P" "$C" sh -c \
        'curl -s -o /dev/null -w "%{http_code} %{time_total}" -m 180 -H "Accept: application/json" -H "Host: $H" -H "Authorization: Bearer $TOK" "http://127.0.0.1:8000$R"'
      echo
    done
  }

  tenant_cond() {
    cond="$1"; rep="$2"
    case "$cond" in
      off) docker stop "$W" >/dev/null 2>&1 ;;
      on)  docker start "$W" >/dev/null 2>&1; sleep 1 ;;
      forced) docker start "$W" >/dev/null 2>&1 ;;
    esac

    docker restart "$C" >/dev/null
    tstart=$(date +%s); w=0
    # Wait for a worker AND the listening socket: worker processes appear a
    # moment before RoadRunner binds :8000, and a request fired in that gap
    # returns 000 in microseconds — a useless sample (measured: 000 in 0.4ms).
    for i in $(seq 1 150); do
      w=$(workers "$C")
      if [ -n "$w" ] && [ "$w" -ge 1 ] 2>/dev/null && [ "$(listening "$C")" = yes ]; then break; fi
      sleep 1
    done
    ready=$(( $(date +%s) - tstart ))
    [ "$cond" = forced ] && docker restart "$W" >/dev/null 2>&1

    # The FIRST requests on the clock are the tenant tier walk (every route,
    # serially, in knob order): exactly the first tenant user's experience
    # scaled up to the tier. The /up burst would hide these costs behind a
    # cheaper boot, so it deliberately does not run here.
    cold=$(tenant_walk)
    sleep "$GAP"
    warm=$(tenant_walk)
    echo "   rep $rep / warmer $cond  (load=$(cut -d' ' -f1 /proc/loadavg), $w workers after ${ready}s)"
    echo "      tier cold walk:"
    echo "$cold" | sed 's/^/         /'
    echo "      tier warm walk (GAP ${GAP}s later):"
    echo "$warm" | sed 's/^/         /'
    echo "      index rebuild procs: $(docker exec "$C" sh -c 'ps -eo args | grep -c "[l]aradocs:index"' 2>/dev/null)"
    # Accumulate per-condition, keeping walk order stable in the log.
    cold_all3="$cold_all3$(echo "$cold" | awk '{printf "%.3f ", $2}')"
    warm_all3="$warm_all3$(echo "$warm" | awk '{printf "%.3f ", $2}')"
  }

  cold_all3=""; warm_all3=""
  for rep in 1 2; do
    tenant_cond off "$rep"
    tenant_cond on "$rep"
  done
  tenant_cond forced 1

  echo
  echo "   --- PHASE 3 summary ('tier win' = cold − warm on the SAME walk; off=baseline, on=warmer racing, forced=warmer restarted first) ---"
  echo "   $TENANT_HOST, tier routes: $TENANT_PATHS"

  echo "   route-by-route raw seconds (walk order = knob order):"
  echo "      cold: $cold_all3"
  echo "      warm: $warm_all3"
  echo "   tier win (cold − warm) per walk: $(awk -v c="$cold_all3" -v w="$warm_all3" -v n="$NROUTES" 'BEGIN{ntok=split(c,cc," "); split(w,wc," "); nw=int(ntok/n); for(i=1;i<=nw;i++){m=0;for(j=1;j<=n;j++){m+=cc[(i-1)*n+j]-wc[(i-1)*n+j]}; printf "%.0fms ",m*1000}; print "(walks="nw")"}')"

  # Tier totals per condition: walks run in the fixed order
  # off,on,off,on,off,on,forced — a walk's total = sum of its NROUTES times.
  # Each condition reports the median tier total (and cold min..max). off is
  # the honest baseline; on walks race the warmer; forced restarts it first.
  eval "$(awk -v n="$NROUTES" -v c="$cold_all3" -v w="$warm_all3" 'BEGIN{
    ntok=split(c,cc," "); mok=split(w,wc," "); nwalks=int(ntok/n);
    for(g=1;g<=nwalks;g++){
      cond=(g==nwalks && nwalks>2)?"FORCED":((g%2)?"OFF":"ON");
      tc=0; tw=0;
      for(j=1;j<=n;j++){ tc+=cc[(g-1)*n+j]; tw+=wc[(g-1)*n+j]; }
      NCNT[cond]++; C[cond,NCNT[cond]]=tc*1000; W[cond,NCNT[cond]]=tw*1000;
    }
    for(k in NCNT){
      m=NCNT[k];
      for(i=1;i<=m;i++) a[i]=C[k,i]; isort(a,m);
      printf "MED_COLD_%s=%.0f\n", k, a[int((m+1)/2)];
      for(i=1;i<=m;i++) a[i]=W[k,i]; isort(a,m);
      printf "MED_WARM_%s=%.0f\n", k, a[int((m+1)/2)];
      mn=0; mx=0;
      for(i=1;i<=m;i++){ if(mn==0||C[k,i]<mn) mn=C[k,i]; if(C[k,i]>mx) mx=C[k,i]; }
      printf "MIN_COLD_%s=%.0f MAX_COLD_%s=%.0f N_%s=%d\n", k, mn, k, mx, k, m;
    }
  }
  function isort(arr,m,   i,j,t){ for(i=1;i<=m;i++) for(j=i+1;j<=m;j++) if(arr[j]<arr[i]){t=arr[i];arr[i]=arr[j];arr[j]=t} }')"
  echo "   tier-walk totals per condition (median cold | min..max, median warm):"
  echo "      off   (n=${N_OFF:-0})  cold: ${MED_COLD_OFF:-n/a}ms (${MIN_COLD_OFF:-}..${MAX_COLD_OFF:-})   warm: ${MED_WARM_OFF:-n/a}ms"
  echo "      on    (n=${N_ON:-0})   cold: ${MED_COLD_ON:-n/a}ms (${MIN_COLD_ON:-}..${MAX_COLD_ON:-})   warm: ${MED_WARM_ON:-n/a}ms"
  [ -n "${MED_COLD_FORCED:-}" ] && echo "      forced            cold: ${MED_COLD_FORCED}ms   warm: ${MED_WARM_FORCED:-n/a}ms"
  fi
fi

echo
restore_warmer; sleep 2
docker inspect "$W" --format '   warmer status={{.State.Status}} health={{.State.Health.Status}}'
echo "== measurement done $(date -u +%H:%M:%S)  load: $(load) =="
