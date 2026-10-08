#!/bin/bash
# Host-side operational job; app releases remain owned by Coolify/Git.
# Credentials: root-only /etc/hive-backup, never in Git or command output.
set -euo pipefail
umask 077
export RESTIC_REPOSITORY=sftp:hive-cpanel-backup:/home/techiveetcom/hive-storage/backups/hive-production-restic
export RESTIC_PASSWORD_FILE=/etc/hive-backup/restic-password
export RESTIC_CACHE_DIR=/var/cache/hive-restic
restic_args=(-o 'sftp.command=ssh -F /etc/hive-backup/ssh_config hive-cpanel-backup -s sftp')
exec 9>/var/lib/hive-backup/backup.lock
flock -n 9 || { echo 'Hive backup already running; skipped.'; exit 0; }
stage=$(mktemp -d /var/lib/hive-backup/stage.XXXXXXXX)
helper="hive-object-backup-$(date -u +%Y%m%dT%H%M%SZ)"
metrics_dir=/var/lib/node_exporter/textfile_collector
install -d -m 755 "$metrics_dir"
cleanup() {
  result=$?
  if docker inspect -f '{{index .Config.Labels "hive.backup-helper"}}' "$helper" 2>/dev/null | grep -qx true; then
    docker rm -f "$helper" >/dev/null 2>&1 || true
  fi
  last_success=0
  if [ -s /var/lib/hive-backup/status.json ]; then
    last_success=$(python3 -c 'import json,datetime; s=json.load(open("/var/lib/hive-backup/status.json"))["last_success_utc"]; print(int(datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()))')
  fi
  { printf 'hive_offsite_backup_last_success_timestamp_seconds %s\n' "$last_success"
    printf 'hive_offsite_backup_last_attempt_timestamp_seconds %s\n' "$(date +%s)"
    printf 'hive_offsite_backup_last_run_success %s\n' "$((result == 0 ? 1 : 0))"
  } > "$metrics_dir/hive_offsite_backup.prom.new"
  chmod 644 "$metrics_dir/hive_offsite_backup.prom.new"
  mv "$metrics_dir/hive_offsite_backup.prom.new" "$metrics_dir/hive_offsite_backup.prom"
  if [ "$result" -ne 0 ]; then
    install -d -m 700 /var/lib/hive-backup/last-failure
    for log in "$stage"/*.log; do test ! -f "$log" || cp "$log" /var/lib/hive-backup/last-failure/; done
    echo 'Hive offsite backup failed. Private diagnostics: /var/lib/hive-backup/last-failure' >&2
  fi
  case "$stage" in /var/lib/hive-backup/stage.*) test ! -L "$stage" && rm -rf -- "$stage" ;; esac
  return "$result"
}
trap cleanup EXIT
app=z140ve7ehjoyuoluqk0azmwe
backend=''; db=''
for attempt in $(seq 1 60); do
  backend=$(docker ps --filter "name=^backend-$app-" --format '{{.Names}}' | head -1)
  db=$(docker ps --filter "name=^db-$app-" --format '{{.Names}}' | head -1)
  if [ -n "$backend" ] && [ -n "$db" ] && \
     [ "$(docker inspect -f '{{.State.Health.Status}}' "$backend" 2>/dev/null || true)" = healthy ] && \
     [ "$(docker inspect -f '{{.State.Health.Status}}' "$db" 2>/dev/null || true)" = healthy ]; then break; fi
  backend=''; db=''
  sleep 5
done
test -n "$backend" && test -n "$db" || { echo 'Hive database/backend did not become healthy within five minutes.' >&2; exit 1; }
batch=$(date -u +%Y%m%dT%H%M%SZ)
docker exec "$db" sh -ec 'pg_dumpall -U "$POSTGRES_USER"' | gzip > "$stage/databases.sql.gz"
gzip -t "$stage/databases.sql.gz"
test "$(stat -c %s "$stage/databases.sql.gz")" -gt 1000
docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}' "$backend" "$db" > "$stage/release.txt"
app_storage=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/www/html/storage/app/private/system-backups"}}{{.Source}}{{end}}{{end}}' "$backend")
test -d "$app_storage"
compose="/data/coolify/applications/$app/docker-compose.yaml"
test -s "$compose"
restic "${restic_args[@]}" backup --host hive-production --tag hive-database-config --tag "$batch" --exclude '*.log' \
  "$stage" "/data/coolify/applications/$app/.env" "$compose" \
  "$app_storage" /etc/hive-backup /usr/local/lib/hive-backup > "$stage/database-backup.log" 2>&1
# Use a dedicated, ephemeral helper from the running backend's immutable image.
# It has no host mounts and no published ports; a Coolify rolling recreation of
# the app container must not kill the long object transfer. Credentials remain
# in this root-only temporary env file and disappear with the staging directory.
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$backend" > "$stage/helper.env"
docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$backend" > "$stage/helper-networks"
network="${app}_hive-network"
grep -Fxq "$network" "$stage/helper-networks"
image=$(docker inspect -f '{{.Image}}' "$backend")
docker create --name "$helper" --label hive.backup-helper=true --network "$network" \
  --memory=384m --cpus=0.5 --env-file "$stage/helper.env" --entrypoint php "$image" -d display_errors=stderr /tmp/backup-s3-stream.php >/dev/null
while IFS= read -r additional_network; do
  test -n "$additional_network" || continue
  if [ "$additional_network" != "$network" ]; then docker network connect "$additional_network" "$helper"; fi
done < "$stage/helper-networks"
docker cp /usr/local/lib/hive-backup/backup-s3-stream.php "$helper":/tmp/backup-s3-stream.php
# pipefail makes a failed S3 read fail the complete run even if Restic receives EOF.
docker start -a "$helper" | \
  restic "${restic_args[@]}" backup --host hive-production --tag hive-objects --tag "$batch" \
    --stdin --stdin-filename objects.tar > "$stage/object-backup.log" 2>&1
test "$(docker inspect -f '{{.State.ExitCode}}' "$helper")" = 0
restic "${restic_args[@]}" check > "$stage/check.log" 2>&1
printf '{"last_success_utc":"%s","batch":"%s","database":"ok","objects":"ok","repository_check":"ok"}\n' \
  "$(date -u +%FT%TZ)" "$batch" > /var/lib/hive-backup/status.json.new
mv /var/lib/hive-backup/status.json.new /var/lib/hive-backup/status.json
echo "Hive encrypted offsite backup succeeded: $batch (database, configuration, logical S3 objects)."
# Initial rollout does not prune snapshots. Enable a reviewed retention policy
# only after independent restore and recovery-password verification.
