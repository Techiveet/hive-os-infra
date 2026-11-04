# Pull-based deployment

GitHub Actions builds and pushes the `backend` / `frontend` images to GHCR, but it
**does not** deploy over SSH — the VPS firewall (Hetzner Cloud Firewall) blocks
inbound SSH from GitHub runners, and we keep SSH closed to the public on purpose.

Instead, the VPS deploys itself: a systemd timer watches GHCR and redeploys when a
new `:latest` image appears (typically within ~2 minutes of a push).

## Install (run once on the VPS, as root)

```bash
# 1. deployer script (already lives in this repo at scripts/auto-deploy.sh)
install -m 0755 /root/projects/hive/scripts/auto-deploy.sh /root/projects/hive/scripts/auto-deploy.sh

# 2. systemd units
cp deploy/hive-autodeploy.service /etc/systemd/system/
cp deploy/hive-autodeploy.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hive-autodeploy.timer
```

## Operate

```bash
systemctl list-timers hive-autodeploy.timer      # when it next runs
systemctl start hive-autodeploy.service          # force a deploy check now
journalctl -u hive-autodeploy.service -n 50      # systemd logs
tail -f storage/logs/auto-deploy.log             # deploy output
```

The deployer is idempotent and single-instance (flock). It only redeploys a service
when its image ID actually changes; otherwise it logs `no change` and exits.

> Infra changes (compose / Caddyfile) are **not** image-based and are still applied
> manually — copy the changed files into `/root/projects/hive` and run
> `scripts/deploy-prod.sh` (or recreate the affected services).

> The backend image runs as `www-data` (uid 82). If this legacy stack bind-mounts
> `./storage/app-storage`, make it writable once before deploying a new image:
> `chown -R 82:82 /root/projects/hive/storage/app-storage`.
