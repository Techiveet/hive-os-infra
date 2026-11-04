# Production health checks and acceptance

## Deployment safety

For a Compose application, maintain health checks per service in
`docker-compose.prod.vps.yml`. Do not substitute a container uptime check for
dependency readiness, successful backup delivery, or an authenticated user flow.

Before deploying, take and verify a private database backup, record running image
digests and persistent mounts, and review the rendered Compose without printing
secrets. A Git push may trigger Coolify auto-deploy. A full Compose deployment may
recreate all services; use an approved maintenance window and check active media
rooms first. Never run database reset commands or remove storage/volumes.

## Readiness coverage

- Backend/frontend: their application health endpoints.
- Queue: expected Horizon process, database, Redis and Horizon status.
- Scheduler: expected schedule worker, database and Redis. This is readiness,
  not scheduled-task execution proof; monitor task heartbeats separately.
- Media server: HTTP readiness; still test a real authenticated media session.
- SeaweedFS bootstrap: authenticated stat of the configured existing bucket.
- Exporters/monitoring: local HTTP endpoints plus actual scrape/dependency metrics.

The optional S3 mirror idles when its credentials are unset. Do not claim it is
delivering backups or attach a fake success health check. The external encrypted
backup timer, where configured, must have independent last-success and restore
verification. Preserve all backup files when changing an idle helper.

## Memory and monitoring

The frontend's default container RAM budget is 1536 MiB, total RAM-plus-swap budget
2048 MiB, and V8 old-space budget 1024 MiB. These are bounded mitigation settings,
not proof a leak is fixed. Do not expand the heap beyond host/container headroom.

cAdvisor provides actual container memory and restart-series metrics. Read-only
Docker/containerd socket mounts remain powerful host-control interfaces; expose
neither them nor monitoring exporters publicly. Keep the pinned exporter image
digests and review upgrades before activation.

Alerts cover frontend probe loss, scrape failure, missing actual frontend-memory
metrics, >85% memory for five minutes, and observed restarts. A changed start-time
series detects an in-place restart, not necessarily a recreation under a new
container identity. Keep the independent frontend-availability check active.

Validate before deployment using the same Prometheus/Alertmanager images:

```sh
promtool check rules monitoring/alert_rules.yml
promtool test rules monitoring/alert_rules_test.yml
promtool test rules monitoring/health_alert_rules_test.yml
```

The existing `monitoring/alertmanager/render-config.sh` renders receivers from
private environment settings. Set `ALERTMANAGER_VALIDATE_ONLY=1` to validate a
candidate receiver configuration with amtool without starting a server. Never
commit tokens/passwords or dump the rendered configuration in CI logs.

Hive Cloud - Hive ERP email/Telegram notifications include alert severity and
firing/recovery state. Receiver counters show transport acceptance, not human
receipt. Send only a clearly labelled, expiring diagnostic alert, then confirm
delivery with the operator. Do not create a permanent test alert or silence real
capacity failures to make a dashboard green.

## Acceptance after a release

1. Confirm all required containers healthy and no restart loops/new fatal errors.
2. Confirm PostgreSQL/Redis dependency metrics equal 1 and every configured
   Prometheus target is up. A healthy scrape alone is insufficient: confirm the
   frontend's actual memory series exists.
3. Check central and registered tenant health/public API endpoints.
4. Use an existing authenticated tenant to test its actual dashboard data.
5. Provision a separately approved isolated temporary tenant without real billing
   or outbound welcome mail, and use the real public API for sign-in/profile.
6. Complete the mandatory first-login password change; do not bypass that policy.
7. Verify dashboard access, anonymous 401, cross-tenant rejection and logout.
8. Check an unknown hostname is not authorized for certificate issuance.
9. Verify canonical backend URLs and real reset/email-link destinations.
10. Compare persistent mounts/customer tenant IDs, check backup last-success,
    and run an approved isolated restore drill.

Long-term frontend stability needs sustained representative traffic and memory
observation. A short sample, one healthy response, or a completed Git push is not
end-to-end production acceptance. Preserve a scoped rollback path and record
pending gates honestly.
