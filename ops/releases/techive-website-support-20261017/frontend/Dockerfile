# Requires the locally built, verified 2c207 frontend image described in ../README.md.
FROM ghcr.io/techiveet/hive-os-frontend:2c2076769368fab771617aa6198780f30dc3906a
COPY --chown=nextjs:nodejs sw.js /app/public/sw.js
LABEL org.opencontainers.image.revision=b0219a2f1fa39db03795337438b8c7ba0a358b05
LABEL org.opencontainers.image.source=https://github.com/Techiveet/hive-os-frontend
