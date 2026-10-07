#!/usr/bin/env bash
# Measures what the backend pre-warmer is actually worth, in two parts.
#
# Run from the repo root:  ./scripts/measure-backend-warmup.sh
# Knobs: SAMPLES (default 3), GAP seconds (default 12), PHASES (1, 2, or 12).
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
# Historical reference on this box when quiet: cold ~1.19s, warm ~12ms. Contention
# inflates both, so always report the load the numbers were taken under.
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

SAMPLES=${SAMPLES:-3}
GAP=${GAP:-12}
PHASES=${PHASES:-12}

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

if [ "$PHASES" = 12 ] || [ "$PHASES" = 1 ]; then
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

if [ "$PHASES" = 12 ] || [ "$PHASES" = 2 ]; then
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

echo
restore_warmer; sleep 2
docker inspect "$W" --format '   warmer status={{.State.Status}} health={{.State.Health.Status}}'
echo "== measurement done $(date -u +%H:%M:%S)  load: $(load) =="
