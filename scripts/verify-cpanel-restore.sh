#!/bin/bash
# Read encrypted offsite snapshots and restore only into an isolated scratch DB.
set -euo pipefail
umask 077
export RESTIC_REPOSITORY=sftp:hive-cpanel-backup:/home/techiveetcom/hive-storage/backups/hive-production-restic
export RESTIC_PASSWORD_FILE=/etc/hive-backup/restic-password
export RESTIC_CACHE_DIR=/var/cache/hive-restic
args=(-o 'sftp.command=ssh -F /etc/hive-backup/ssh_config hive-cpanel-backup -s sftp')
exec 9>/var/lib/hive-backup/backup.lock
flock -n 9 || { echo 'Backup or verification running; retry verification later.' >&2; exit 1; }
test -s /var/lib/hive-backup/status.json
batch=$(python3 -c 'import json,re; s=json.load(open("/var/lib/hive-backup/status.json")); b=s["batch"]; assert re.fullmatch(r"[0-9]{8}T[0-9]{6}Z",b) and all(s[k]=="ok" for k in ("database","objects","repository_check")); print(b)')
stage=$(mktemp -d /var/lib/hive-backup/restore.XXXXXXXX)
container="hive-offsite-restore-check-$(date -u +%Y%m%dT%H%M%SZ)"
cleanup() {
  result=$?
  if docker inspect -f '{{index .Config.Labels "hive.restore-verification"}}' "$container" 2>/dev/null | grep -qx true; then docker rm -f "$container" >/dev/null; fi
  if [ "$result" -ne 0 ]; then
    install -d -m 700 /var/lib/hive-backup/restore-last-failure
    test ! -s "$stage/restore.log" || cp "$stage/restore.log" /var/lib/hive-backup/restore-last-failure/
  fi
  case "$stage" in /var/lib/hive-backup/restore.*) test ! -L "$stage" && rm -rf -- "$stage" ;; esac
  return "$result"
}
trap cleanup EXIT
restic "${args[@]}" snapshots --host hive-production --tag "$batch" --json > "$stage/snapshots.json"
snapshot=$(python3 -c 'import json,sys; a=[s["id"] for s in json.load(open(sys.argv[1])) if "hive-database-config" in s.get("tags",[])]; assert len(a)==1; print(a[0])' "$stage/snapshots.json")
object_snapshot=$(python3 -c 'import json,sys; a=[s["id"] for s in json.load(open(sys.argv[1])) if "hive-objects" in s.get("tags",[])]; assert len(a)==1; print(a[0])' "$stage/snapshots.json")
restic "${args[@]}" ls "$snapshot" --json > "$stage/files.jsonl"
dump_path=$(python3 -c 'import json,sys; a=[json.loads(l) for l in open(sys.argv[1])]; p=[x["path"] for x in a if x.get("type")=="file" and x.get("name")=="databases.sql.gz"]; assert len(p)==1; print(p[0])' "$stage/files.jsonl")
restic "${args[@]}" dump "$snapshot" "$dump_path" > "$stage/restored.sql.gz"
gzip -t "$stage/restored.sql.gz"
db=$(docker ps --filter name=^db-z140ve7ehjoyuoluqk0azmwe- --format '{{.Names}}' | head -1)
image=$(docker inspect -f '{{.Image}}' "$db")
docker run -d --name "$container" --label hive.restore-verification=true --network none --memory=1g \
  --tmpfs /var/lib/postgresql/data:rw,size=1073741824,mode=0700 \
  -e POSTGRES_USER=hive_restore_verifier -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
ready=false
for i in $(seq 1 30); do
  if docker exec "$container" pg_isready -U hive_restore_verifier >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
gzip -dc "$stage/restored.sql.gz" | docker exec -i "$container" psql -q -v ON_ERROR_STOP=1 -U hive_restore_verifier -d postgres > "$stage/restore.log" 2>&1
docker exec "$container" psql -At -U hive_restore_verifier -d hive -c 'SELECT count(*) FROM users; SELECT count(*) FROM tenants;' | awk 'NR==1{print "Restored central users=" $1} NR==2{print "Restored tenants=" $1}'
docker exec "$container" psql -At -U hive_restore_verifier -d postgres -c "SELECT count(*) FROM pg_database WHERE datistemplate = false;" | awk '{print "Restored databases=" $1}'
echo 'Full SQL restore succeeded with ON_ERROR_STOP in a network-isolated temporary PostgreSQL container.'
restic "${args[@]}" dump "$object_snapshot" objects.tar | python3 /usr/local/lib/hive-backup/verify-object-archive.py
restic "${args[@]}" check
echo "Database and all object bytes restored and verified from encrypted cPanel backup batch $batch."
