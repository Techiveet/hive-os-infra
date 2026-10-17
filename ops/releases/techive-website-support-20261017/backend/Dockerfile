FROM ghcr.io/techiveet/hive-os-backend@sha256:f3cfea396dc6cb6dff140b085896b113c5280d45a0a27ec2a689bc10a2d4c314
COPY app.patch /tmp/queen-bee-release.patch
RUN git apply --check /tmp/queen-bee-release.patch && git apply /tmp/queen-bee-release.patch && rm /tmp/queen-bee-release.patch
LABEL org.opencontainers.image.revision=67c686bb2c6ea6d4a3d6f80fadb02b3d37e2249f
LABEL org.opencontainers.image.source=https://github.com/Techiveet/hive-os-backend
