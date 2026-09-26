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

All public traffic for every site on this host (Hive, Swift, Dejen, Aqua Uno,
Gubae, LiveKit, the EV tenant APIs, Hive Owl, SSO and the Coolify UI itself)
enters through Coolify's own proxy, `coolify-proxy` (Caddy via
caddy-docker-proxy). The standalone `hive-caddy` container was retired on
2026-09-26.

- Routing lives in one file, `/data/coolify/proxy/caddy/dynamic/edge.caddy`
  (Coolify: Server, Proxy, Dynamic Configurations). Caddy reloads it
  automatically.
- Hive tenant custom domains get certificates on demand; the backend approves
  each domain through `/api/internal/caddy/allow-domain`.
- The proxy joins every Coolify app network, so upstream names in `edge.caddy`
  must be unique across all apps (Swift's web service is `swift-app` because
  Aqua Uno also has a service called `app`).

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

## Migrations and seeders

Every deploy runs `php artisan hive:deploy --force` in the backend container
before Octane starts:

1. Lists pending migrations for the central database and every workspace
   database.
2. Refuses to run anything if a pending migration would delete data (drops a
   column or table, truncates). CI blocks such migrations on the PR unless
   they carry `@hive-allow-data-loss <reason>`.
3. Dumps each database that has pending migrations to
   `storage/app/private/system-backups/pre-deploy/<timestamp>/` (the
   `hive-app-backups` volume; the last 5 runs are kept).
4. Runs `migrate` and `tenants:migrate`. Migrations only add what is missing;
   existing rows are kept.
5. Adds new permissions: created, granted to Super Admin and to the built-in
   roles that include them. Customised roles are never reset.
6. Runs each seeder listed in the backend's `config/deploy.php` once per
   database, recorded in `deploy_seeder_runs`. Workspaces in
   `tenancy.migrated_tenants` (Aqua-Uno) never get tenant seeders.

If it fails, the output is in the backend container log starting with
`hive:deploy FAILED`; the app keeps running on the current schema. To see what
a deploy would do without changing anything:

```bash
docker exec hive-backend php artisan hive:deploy --pretend
```

## Backups

Coolify scheduled tasks run `sh /backups/backup.sh` nightly in each app's
MySQL container and keep 14 days under `/srv/<app>/backups`: Swift 02:30,
Dejen 02:45, Aqua Uno 03:00 (UTC). Hive's own scheduler runs
`system-backups:run` at 02:00.

For Hive itself:

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
bearer token equal to `METRICS_TOKEN`. For defence in depth, also add
`respond /metrics 404` to the Hive backend site in `edge.caddy`.

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
