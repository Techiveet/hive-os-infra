# Hive production on Coolify

Production (78.47.138.239) runs entirely from Coolify application
`z140ve7ehjoyuoluqk0azmwe` (project "Hive ERP SaaS", team "Root Team"),
built from `docker-compose.prod.vps.yml` on `main` of this repository.

## Deploying

A push to `main` deploys automatically through the `techiveet-hive-cloud`
GitHub App (installed on this repository only). A deploy recreates every
service in the stack, so expect a short restart of Postgres, Redis and the app
containers. To deploy by hand: Coolify, open the application, Actions, Deploy.

If a push does not start a deployment, check the App's recent deliveries on
GitHub (Settings, Developer settings, GitHub Apps, `techiveet-hive-cloud`,
Advanced).

## Data

These host directories hold customer data and must never be removed:

| Service     | Host path                                     |
|-------------|-----------------------------------------------|
| Postgres    | `/root/projects/hive/storage/db-data`         |
| Meilisearch | `/root/projects/hive/storage/search-data`     |
| SeaweedFS   | `/root/projects/hive/storage/seaweedfs-data`  |
| rembg model | `/root/projects/hive/storage/rembg-models`    |

## Compose rules that Coolify enforces

- Coolify attaches every service to its own network as well as the ones
  declared here, so a container can have several IPs. Services must listen on
  all interfaces (see the SeaweedFS `-ip.bind=0.0.0.0` flag).
- Coolify drops network entries with a null value. Give every mapping-style
  network entry a value (for example `aliases`).
- Short names such as `redis` or `gotenberg` resolve across every attached
  network. Never run a second container under the same alias on
  `hive_hive-network`, or the backend may reach it instead of the Coolify one.
- Keep the per-service `deploy.resources.limits` and log rotation. The host has
  7.7 GB of RAM and no swap; an uncapped service can trigger a host-wide OOM.
- `rembg` is pinned by digest. Newer images exceed the 1.5 GB limit.
- SeaweedFS requires signed S3 requests. Its identity file is generated at
  start-up from `SEAWEEDFS_ACCESS_KEY` / `SEAWEEDFS_SECRET_KEY`, which must
  match the backend's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
- The `scheduler` service runs Laravel's `schedule:work` (backups, trash purge,
  integrations). Do not remove it.

## Edge proxy

Public traffic for every site on this host still enters through the standalone
`hive-caddy` container (ports 80/443), not Coolify's proxy. It fronts Hive,
Dejen, Swift, Gubae, LiveKit, Aqua Uno, the EV tenant APIs and the Coolify UI
itself. Do not stop it until those routes have moved to Coolify's proxy.

## Required settings

The compose file refuses to start (`required variable ... is missing`) unless
these are set in the Coolify application's environment. There are no
fallback values: the old defaults were committed to this repository, so a
missing variable used to mean a publicly known key.

`APP_KEY`, `DB_PASSWORD`, `REDIS_PASSWORD`, `SEAWEEDFS_SECRET_KEY`,
`MEILISEARCH_KEY`, `REVERB_APP_ID`, `REVERB_APP_KEY`, `REVERB_APP_SECRET`,
`GRAFANA_ADMIN_PASSWORD`, `HIVE_VIDEO_SECRET`, `VIDEO_AUTH_TOKEN_SECRET`,
`VIDEO_BILLING_WEBHOOK_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

Setting `REDIS_PASSWORD` for the first time turns on Redis authentication;
the backend, queue, scheduler and Reverb read the same variable, so they
reconnect with it on the same deploy.

## Migrations

The backend container runs `migrate --force` and `tenants:migrate --force`
before Octane starts, and only reports healthy afterwards. The queue,
scheduler, Reverb and frontend wait for that, so nothing runs against an old
schema. A failed migration keeps the backend unhealthy and the deploy fails
visibly; check the backend logs.

## Backups

- `db-backup` runs `pg_dumpall` daily (every workspace database, not just
  central) into `/root/projects/hive/storage/db-backups`, keeping 7 daily,
  4 weekly and 6 monthly dumps.
- `db-backup-offsite` mirrors that directory to `BACKUP_REMOTE_*`. Until those
  are set it logs a warning and backups exist only on this server. Use a
  private bucket with server-side encryption, outside Hetzner.
- In-app backups (Settings > Backups) now include every workspace database
  and are kept in the `hive-app-backups` volume, which survives redeploys.
  `BACKUP_DISKS=local,backups` also copies them to `BACKUP_S3_*`.

A backup that has never been restored is not a backup. At least monthly,
restore the latest dump into a scratch Postgres and check a workspace:

```bash
docker run -d --name hive-restore-check -e POSTGRES_PASSWORD=check postgres:17-alpine
sleep 10
gunzip -c /root/projects/hive/storage/db-backups/last/*-latest.sql.gz \
  | docker exec -i hive-restore-check psql -q -U postgres -d postgres
docker exec hive-restore-check psql -U postgres -l   # every tenant<id> database is listed
docker rm -f hive-restore-check
```

## Alerts

Prometheus, Alertmanager, node-exporter and blackbox-exporter run by default
(Grafana and cAdvisor stay behind the `ops` profile). Prometheus scrapes the
backend's `/metrics`, which reports database, Redis, queue and backup health,
and evaluates `monitoring/alert_rules.yml`. Alertmanager delivers to
`ALERT_EMAIL_TO` via `ALERT_SMTP_*` and/or to `ALERT_WEBHOOK_URL`. With none
set it logs a warning and nobody is notified.

`/metrics` answers only callers on the private network (Prometheus), or a
bearer token equal to `METRICS_TOKEN`; the edge Caddy also returns 404 for it.

## Rolling back

CI pushes every build as `:latest` and as `:<commit sha>`. To roll back, set
`HIVE_BACKEND_TAG` and/or `HIVE_FRONTEND_TAG` to the previous commit's SHA in
Coolify and redeploy; set them back to `latest` afterwards. A rollback across
a migration may also need that migration reverted.

## Known limits of this setup

These need changes in Coolify or on the host, not in this file:

- **Every deploy restarts Postgres and Redis.** Coolify recreates the whole
  stack on each deploy, so each backend or frontend release briefly takes the
  database down. Move `db`, `redis`, `seaweedfs`, `meilisearch`, `db-backup`
  and `db-backup-offsite` into a separate Coolify resource that is only
  redeployed on purpose; the application services reach them over the
  external `hive_hive-network` they already share.
- **Memory is overcommitted.** The per-service limits add up to more than the
  host's 7.7 GB, and the host has no swap. Add swap
  (`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile &&
  swapon /swapfile`, plus an `/etc/fstab` entry) so a spike slows the host
  instead of triggering the OOM killer, or move to a larger server.
- **One server.** Postgres has no replica; restoring from the off-site
  backups is the recovery path if the host is lost.
