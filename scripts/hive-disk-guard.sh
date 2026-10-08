#!/usr/bin/env bash
# Operational cache cleanup only. Never delete images, volumes, customer
# storage, database dumps, or rollback resources to satisfy a disk threshold.
set -u
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec 9>/run/hive-disk-guard.lock
flock -n 9 || exit 0
log(){ logger -t hive-disk-guard -- "$*"; printf '%s %s\n' "$(date -Is)" "$*"; }
usage(){ df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}'; }
before=$(usage)
log "start usage=${before}%"
active=$(docker exec coolify php artisan tinker --execute='echo App\Models\ApplicationDeploymentQueue::whereIn("status",["queued","in_progress"])->count();' 2>/dev/null | tail -1)
if [ "$before" -ge 80 ]; then
  if [ "$active" = 0 ]; then
    docker builder prune -af --filter until=24h >/dev/null 2>&1 || log 'WARN aged build-cache cleanup failed'
    if [ "$(usage)" -ge 95 ]; then
      docker builder prune -af --filter until=1h >/dev/null 2>&1 || log 'WARN emergency aged cache cleanup failed'
    fi
  else
    log 'WARN cache cleanup skipped: deployment active or deployment status unavailable'
  fi
  journalctl --vacuum-size=250M >/dev/null 2>&1 || log 'WARN journal size limit failed'
fi
after=$(usage)
if [ "$after" -ge 80 ]; then log "WARN disk remains ${after}%; review capacity without deleting operational data"; fi
if [ "$after" -ge 95 ]; then log "CRITICAL usage=${after}% after safe cleanup"; fi
# Preserve the existing stopped-service recovery behaviour. Never recreate a
# database or restart a healthy service just to reclaim disk.
db_state=$(docker inspect -f '{{.State.Status}}' coolify-db 2>/dev/null || true)
if [ "$db_state" != running ] && [ "$after" -lt 98 ]; then
  log "recovering coolify-db state=${db_state:-missing}"
  docker restart coolify-db >/dev/null 2>&1 || log 'ERROR coolify-db restart failed'
  sleep 8
fi
coolify_state=$(docker inspect -f '{{.State.Status}}' coolify 2>/dev/null || true)
if [ "$coolify_state" != running ] && [ "$after" -lt 98 ]; then
  log "recovering coolify state=${coolify_state:-missing}"
  docker restart coolify >/dev/null 2>&1 || log 'ERROR coolify restart failed'
fi
log "finish usage=$(usage)%"
