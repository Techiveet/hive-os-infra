FROM ghcr.io/techiveet/hive-os-backend@sha256:f3cfea396dc6cb6dff140b085896b113c5280d45a0a27ec2a689bc10a2d4c314
COPY app.patch /tmp/combined-branches.patch
RUN git apply --check /tmp/combined-branches.patch && git apply /tmp/combined-branches.patch && rm /tmp/combined-branches.patch
LABEL org.opencontainers.image.revision=0e88096ee763792bfdfe3e97b0c01c32ce3d5ed1
LABEL org.opencontainers.image.source=https://github.com/Techiveet/hive-os-backend
