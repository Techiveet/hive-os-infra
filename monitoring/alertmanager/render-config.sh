#!/bin/sh
# Renders the production Alertmanager config from environment variables, so
# receivers and credentials live in Coolify's .env rather than in this repo.
#
#   ALERT_EMAIL_TO        comma-separated recipients
#   ALERT_SMTP_HOST       host:port of an SMTP relay
#   ALERT_SMTP_FROM       sender address
#   ALERT_SMTP_USERNAME   optional
#   ALERT_SMTP_PASSWORD   optional
#   ALERT_WEBHOOK_URL     optional; receives Alertmanager's JSON payload
#
# With none of them set, alerts are still evaluated and visible in the
# Alertmanager UI, but nobody is notified; the container logs a warning.
set -eu

config=/tmp/alertmanager.yml
receiver_body=""

if [ -n "${ALERT_EMAIL_TO:-}" ] && [ -n "${ALERT_SMTP_HOST:-}" ] && [ -n "${ALERT_SMTP_FROM:-}" ]; then
  receiver_body="${receiver_body}
    email_configs:
      - to: '${ALERT_EMAIL_TO}'
        from: '${ALERT_SMTP_FROM}'
        smarthost: '${ALERT_SMTP_HOST}'
        auth_username: '${ALERT_SMTP_USERNAME:-}'
        auth_password: '${ALERT_SMTP_PASSWORD:-}'
        require_tls: true
        send_resolved: true"
fi

if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
  receiver_body="${receiver_body}
    webhook_configs:
      - url: '${ALERT_WEBHOOK_URL}'
        send_resolved: true"
fi

if [ -z "$receiver_body" ]; then
  echo "alertmanager: WARNING no ALERT_EMAIL_TO/ALERT_SMTP_* or ALERT_WEBHOOK_URL set; alerts will not be delivered." >&2
fi

cat > "$config" <<YAML
route:
  receiver: oncall
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

inhibit_rules:
  - source_matchers: ['alertname = "PostgresDown"']
    target_matchers: ['alertname =~ "PostgresConnections.*|PostgresLockWait.*|High5xxRate|Critical5xxRate|ElevatedP95Latency|CriticalP95Latency"']
  - source_matchers: ['alertname = "RedisDown"']
    target_matchers: ['alertname =~ "QueueBacklog.*|QueueOldestJob.*|RedisMemoryHigh"']

receivers:
  - name: oncall${receiver_body}
YAML

exec /bin/alertmanager --config.file="$config" --storage.path=/alertmanager "$@"
