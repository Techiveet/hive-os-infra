# Hive OS encrypted offsite backups

## Production deployment and ownership

Application releases are pulled and deployed by the Git-connected Coolify
application `z140ve7ehjoyuoluqk0azmwe`, from `Techiveet/hive-os-infra`, `main`.
Do not edit application source in running containers. The host backup job is an
operational utility, not a second application deployment mechanism.

## Destination and credentials

- SSH/SFTP server: `sunset.hostns.io:22`, account `techiveetcom`.
- Dedicated encrypted repository:
  `/home/techiveetcom/hive-storage/backups/hive-production-restic`.
- This is outside `public_html`, owner-only, and separate from EV backups.
- Root-only credentials and pinned SSH host keys: `/etc/hive-backup`.
- Never print, commit, email, or paste private keys or the Restic password.
- The SSH key has cPanel-account access; `restrict` disables forwarding/PTY,
  but does **not** make the key folder-only. This scope was explicitly approved.
- Keep the recovery package offline. Losing the Restic password makes the
  encrypted backups unrecoverable. Register a replacement cPanel SSH key if the
  production VPS is lost.

## What is backed up

`/usr/local/sbin/hive-cpanel-backup` is installed from
`scripts/hive-cpanel-backup.sh`, with the PHP stream helper from
`scripts/backup-s3-stream.php` under `/usr/local/lib/hive-backup`.
The reviewed unit and timer templates are tracked under `deploy/`. Updating
these operational files in Git does not install them on the host automatically;
install the scripts with root-only permissions, copy the units into
`/etc/systemd/system`, and run `systemctl daemon-reload` after review. Do not
replace `/etc/hive-backup` credentials when updating utilities.

Each run creates two encrypted snapshots with a shared UTC batch tag:

1. `hive-database-config`: `pg_dumpall` of central and all tenant databases,
   current generated Coolify Compose/environment, release image identifiers,
   persistent in-app system backups, and backup utility configuration.
2. `hive-objects`: an S3-level archive of all Hive SeaweedFS buckets, object
   contents, keys, selected metadata, sizes and SHA-256 hashes. Object data is
  streamed directly into Restic, avoiding an extra 4 GB local staging copy.

The object stream runs in a temporary helper using the running backend's
immutable image, with no host mounts or public ports. It is independent of
the replaceable app container and is removed after the job. Application
credentials are passed only through a root-only temporary environment file.

Raw running PostgreSQL files and mutable SeaweedFS indexes are not used as
restorable backups. Redis cache and Meilisearch indexes are not included in
this job; operational rollback backups are separate and retained.

This is an **online** backup, not a coordinated cross-database/object-store
point-in-time snapshot. `pg_dumpall` snapshots each database independently.
S3 reads are guarded with each object's ETag; concurrent changes can make the
job fail instead of silently claiming success. For a strict cross-service
snapshot, approve a write-maintenance window or adopt storage snapshots/PITR.
The job does not provide a 60-second WAL/PITR recovery guarantee.

## Schedule, status and alerts

After the initial restore check, enable `hive-cpanel-backup.timer`: daily at
01:30 UTC plus up to 15 minutes jitter; missed runs catch up after boot.

```bash
systemctl list-timers hive-cpanel-backup.timer
systemctl start hive-cpanel-backup.service
systemctl status hive-cpanel-backup.service
journalctl -u hive-cpanel-backup.service --since today
cat /var/lib/hive-backup/status.json
```

A file lock prevents overlapping runs. Failure logs remain root-only under
`/var/lib/hive-backup/last-failure`. A successful run requires database dump
validation, both snapshot operations and `restic check`. Node Exporter's
textfile collector exports last-success time and last-run status. Prometheus
alerts on failure or a backup older than 30 hours through Hive's configured
Alertmanager receiver.

The optional Compose `db-backup-offsite` S3 mirror is not this SFTP job. Its
empty `BACKUP_REMOTE_*` settings are not evidence that the cPanel job failed.
Do not configure both to the same directory or confuse an idle S3 mirror
with the authoritative encrypted offsite backup.

Initial rollout preserves every snapshot; no automated remote pruning is
enabled until restore and offline credential recovery are accepted. Review
7 daily / 4 weekly / 6 monthly retention using `restic forget --dry-run`,
scoped to `--host hive-production`, grouped by host and backup type rather
than the unique batch tag. Never prune another project's repository.

## Restore without touching production

The host verification utility is tracked as `scripts/verify-cpanel-restore.sh`.
Install it as `/usr/local/lib/hive-backup/verify-offsite-restore.sh` with root-only
permissions. It locks out overlapping backups, selects both snapshots from the
completed batch in `status.json` (never a newer partial run), restores SQL into
a network-isolated temporary PostgreSQL container and streams all object bytes
through the manifest verifier. Private SQL failure details stay on the host.

1. Load the repository/password/SSH configuration in a private recovery shell.
2. List snapshots and choose the two entries with a matching UTC batch tag.
3. Restore `databases.sql.gz` into a scratch directory. Verify `gzip -t`.
4. Restore SQL with `psql -v ON_ERROR_STOP=1` into a new, isolated PostgreSQL 17
   instance. Do not pipe it into the production database.
5. Confirm central users/tenants and all tenant databases are present.
6. Stream `objects.tar` through `scripts/verify-object-archive.py`; every size
   and SHA-256 must match its encrypted manifest.
7. To restore objects to a **new** S3 instance, create each manifest bucket,
   upload the hashed archive entry using its original manifest key, and
   restore content type/cache control/custom metadata. Validate application
   records against the restored objects before any routing cutover.
8. Restore application credentials privately, deploy a reviewed immutable
   release in Coolify, test authentication and tenant isolation, then seek
   approval before production routing changes.

References: [Restic SFTP repositories](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html),
[retention](https://restic.readthedocs.io/en/stable/060_forget.html).
