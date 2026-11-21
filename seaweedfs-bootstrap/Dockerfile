FROM alpine:3.22

RUN apk update && apk upgrade --no-cache \
    && apk add --no-cache ca-certificates aws-cli

COPY mc /usr/local/bin/mc
RUN chmod 0755 /usr/local/bin/mc \
    && mc --version

ENTRYPOINT ["mc"]
