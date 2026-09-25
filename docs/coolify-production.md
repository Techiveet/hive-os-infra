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
