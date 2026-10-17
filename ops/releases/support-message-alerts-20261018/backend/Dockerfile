FROM ghcr.io/techiveet/hive-os-backend@sha256:f3cfea396dc6cb6dff140b085896b113c5280d45a0a27ec2a689bc10a2d4c314
COPY app.patch /tmp/support-message-alerts.patch
RUN git apply --check /tmp/support-message-alerts.patch && git apply /tmp/support-message-alerts.patch && rm /tmp/support-message-alerts.patch
LABEL org.opencontainers.image.revision=02d756da45f80c28b6fafe80c3ec10818c887ef3
LABEL org.opencontainers.image.source=https://github.com/Techiveet/hive-os-backend
