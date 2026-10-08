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
#   ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID optional; native Telegram
#
# With none of them set, alerts are still evaluated and visible in the
# Alertmanager UI, but nobody is notified; the container logs a warning.
set -eu

config=/tmp/alertmanager.yml
receiver_body=""

# YAML single-quoted values escape apostrophes by doubling them. Reject line
# breaks so a malformed secret cannot create additional configuration fields.
yaml_value() {
  if [ "$(printf '%s' "$1" | tr -d '\r\n')" != "$1" ]; then
    echo "alertmanager: multiline receiver values are not supported" >&2
    exit 1
  fi
  printf '%s' "$1" | sed "s/'/''/g"
}

if [ -n "${ALERT_EMAIL_TO:-}" ] && [ -n "${ALERT_SMTP_HOST:-}" ] && [ -n "${ALERT_SMTP_FROM:-}" ]; then
  receiver_body="${receiver_body}
    email_configs:
      - to: '$(yaml_value "${ALERT_EMAIL_TO}")'
        from: '$(yaml_value "${ALERT_SMTP_FROM}")'
        smarthost: '$(yaml_value "${ALERT_SMTP_HOST}")'
        auth_username: '$(yaml_value "${ALERT_SMTP_USERNAME:-}")'
        auth_password: '$(yaml_value "${ALERT_SMTP_PASSWORD:-}")'
        require_tls: true
        send_resolved: true"
fi

if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
  receiver_body="${receiver_body}
    webhook_configs:
      - url: '$(yaml_value "${ALERT_WEBHOOK_URL}")'
        send_resolved: true"
fi

if [ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" ] || [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]; then
  if [ -z "${ALERT_TELEGRAM_BOT_TOKEN:-}" ] || ! printf '%s' "${ALERT_TELEGRAM_CHAT_ID:-}" | grep -Eq '^-?[0-9]+$'; then
    echo "alertmanager: Telegram requires both a bot token and a numeric chat ID" >&2
    exit 1
  fi
  receiver_body="${receiver_body}
    telegram_configs:
      - bot_token: '$(yaml_value "${ALERT_TELEGRAM_BOT_TOKEN}")'
        chat_id: ${ALERT_TELEGRAM_CHAT_ID}
        send_resolved: true
        parse_mode: ''
        message: 'Hive OS: {{ .Status }}{{ range .Alerts }} | {{ .Labels.alertname }}: {{ .Annotations.summary }}{{ end }}'"
fi

if [ -z "$receiver_body" ]; then
  echo "alertmanager: WARNING no email, webhook, or Telegram receiver set; alerts will not be delivered." >&2
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
