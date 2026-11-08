FROM alpine:3.21

RUN apk add --no-cache pgbouncer postgresql-client && \
    mkdir -p /etc/pgbouncer /var/run/pgbouncer && \
    chown -R postgres:postgres /etc/pgbouncer /var/run/pgbouncer

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER postgres
EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
