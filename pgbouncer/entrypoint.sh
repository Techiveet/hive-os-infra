#!/bin/sh
set -eu

DB_HOST="${DB_UPSTREAM_HOST:-db}"
DB_PORT="${DB_UPSTREAM_PORT:-5432}"
DB_USER="${DB_USERNAME:-hive}"
DB_PASS="${DB_PASSWORD:-password}"
POOL_MODE="${PGBOUNCER_POOL_MODE:-transaction}"
MAX_CLIENT_CONN="${PGBOUNCER_MAX_CLIENT_CONN:-1000}"
DEFAULT_POOL_SIZE="${PGBOUNCER_DEFAULT_POOL_SIZE:-20}"
MIN_POOL_SIZE="${PGBOUNCER_MIN_POOL_SIZE:-2}"
RESERVE_POOL_SIZE="${PGBOUNCER_RESERVE_POOL_SIZE:-5}"
RESERVE_POOL_TIMEOUT="${PGBOUNCER_RESERVE_POOL_TIMEOUT:-3}"
MAX_DB_CONNECTIONS="${PGBOUNCER_MAX_DB_CONNECTIONS:-50}"
MAX_USER_CONNECTIONS="${PGBOUNCER_MAX_USER_CONNECTIONS:-250}"
MAX_PREPARED_STATEMENTS="${PGBOUNCER_MAX_PREPARED_STATEMENTS:-200}"
SERVER_IDLE_TIMEOUT="${PGBOUNCER_SERVER_IDLE_TIMEOUT:-120}"

ESCAPED_USER=$(printf '%s' "$DB_USER" | sed 's/"/""/g')
ESCAPED_PASS=$(printf '%s' "$DB_PASS" | sed 's/"/""/g')

cat > /etc/pgbouncer/userlist.txt <<EOF
"${ESCAPED_USER}" "${ESCAPED_PASS}"
EOF
chmod 600 /etc/pgbouncer/userlist.txt

cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
* = host=${DB_HOST} port=${DB_PORT}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
unix_socket_dir = /var/run/pgbouncer
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
admin_users = ${DB_USER}
stats_users = ${DB_USER}
pool_mode = ${POOL_MODE}
max_client_conn = ${MAX_CLIENT_CONN}
default_pool_size = ${DEFAULT_POOL_SIZE}
min_pool_size = ${MIN_POOL_SIZE}
reserve_pool_size = ${RESERVE_POOL_SIZE}
reserve_pool_timeout = ${RESERVE_POOL_TIMEOUT}
max_db_connections = ${MAX_DB_CONNECTIONS}
max_user_connections = ${MAX_USER_CONNECTIONS}
max_prepared_statements = ${MAX_PREPARED_STATEMENTS}
server_idle_timeout = ${SERVER_IDLE_TIMEOUT}
server_reset_query = DISCARD ALL
ignore_startup_parameters = extra_float_digits,options,search_path
log_connections = 0
log_disconnections = 0
log_pooler_errors = 1
EOF

exec pgbouncer /etc/pgbouncer/pgbouncer.ini
