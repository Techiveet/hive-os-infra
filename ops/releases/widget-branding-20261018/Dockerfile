FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_CENTRAL_DOMAINS
ARG NEXT_PUBLIC_ROOT_DOMAIN
ARG NEXT_PUBLIC_SERVER_IP
ARG NEXT_PUBLIC_FRONTEND_DOMAIN
ARG NEXT_PUBLIC_BACKEND_DOMAIN
ARG NEXT_PUBLIC_REVERB_DOMAIN
ARG NEXT_PUBLIC_REVERB_APP_KEY
ARG NEXT_PUBLIC_REVERB_HOST
ARG NEXT_PUBLIC_REVERB_PORT
ARG NEXT_PUBLIC_REVERB_SCHEME
ARG INTERNAL_API_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_SKIP_BUILD_TYPECHECK=0

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_CENTRAL_DOMAINS=$NEXT_PUBLIC_CENTRAL_DOMAINS \
    NEXT_PUBLIC_ROOT_DOMAIN=$NEXT_PUBLIC_ROOT_DOMAIN \
    NEXT_PUBLIC_SERVER_IP=$NEXT_PUBLIC_SERVER_IP \
    NEXT_PUBLIC_FRONTEND_DOMAIN=$NEXT_PUBLIC_FRONTEND_DOMAIN \
    NEXT_PUBLIC_BACKEND_DOMAIN=$NEXT_PUBLIC_BACKEND_DOMAIN \
    NEXT_PUBLIC_REVERB_DOMAIN=$NEXT_PUBLIC_REVERB_DOMAIN \
    NEXT_PUBLIC_REVERB_APP_KEY=$NEXT_PUBLIC_REVERB_APP_KEY \
    NEXT_PUBLIC_REVERB_HOST=$NEXT_PUBLIC_REVERB_HOST \
    NEXT_PUBLIC_REVERB_PORT=$NEXT_PUBLIC_REVERB_PORT \
    NEXT_PUBLIC_REVERB_SCHEME=$NEXT_PUBLIC_REVERB_SCHEME \
    INTERNAL_API_URL=$INTERNAL_API_URL \
    NEXT_SKIP_BUILD_TYPECHECK=$NEXT_SKIP_BUILD_TYPECHECK

# Build the application
RUN NODE_OPTIONS=--max-old-space-size=2048 RAYON_NUM_THREADS=2 npx next build --webpack

# Reuse the previous verified build cache, then compile the one-file footer change.
FROM builder AS branding_builder
COPY --from=branding /components/support-bot/support-webchat-widget.tsx /app/components/support-bot/support-webchat-widget.tsx
RUN NODE_OPTIONS=--max-old-space-size=2048 RAYON_NUM_THREADS=2 npx next build --webpack

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_CENTRAL_DOMAINS
ARG NEXT_PUBLIC_ROOT_DOMAIN
ARG NEXT_PUBLIC_SERVER_IP
ARG NEXT_PUBLIC_FRONTEND_DOMAIN
ARG NEXT_PUBLIC_BACKEND_DOMAIN
ARG NEXT_PUBLIC_REVERB_DOMAIN
ARG NEXT_PUBLIC_REVERB_APP_KEY
ARG NEXT_PUBLIC_REVERB_HOST
ARG NEXT_PUBLIC_REVERB_PORT
ARG NEXT_PUBLIC_REVERB_SCHEME
ARG INTERNAL_API_URL
ARG NEXT_PUBLIC_SENTRY_DSN

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_CENTRAL_DOMAINS=$NEXT_PUBLIC_CENTRAL_DOMAINS \
    NEXT_PUBLIC_ROOT_DOMAIN=$NEXT_PUBLIC_ROOT_DOMAIN \
    NEXT_PUBLIC_SERVER_IP=$NEXT_PUBLIC_SERVER_IP \
    NEXT_PUBLIC_FRONTEND_DOMAIN=$NEXT_PUBLIC_FRONTEND_DOMAIN \
    NEXT_PUBLIC_BACKEND_DOMAIN=$NEXT_PUBLIC_BACKEND_DOMAIN \
    NEXT_PUBLIC_REVERB_DOMAIN=$NEXT_PUBLIC_REVERB_DOMAIN \
    NEXT_PUBLIC_REVERB_APP_KEY=$NEXT_PUBLIC_REVERB_APP_KEY \
    NEXT_PUBLIC_REVERB_HOST=$NEXT_PUBLIC_REVERB_HOST \
    NEXT_PUBLIC_REVERB_PORT=$NEXT_PUBLIC_REVERB_PORT \
    NEXT_PUBLIC_REVERB_SCHEME=$NEXT_PUBLIC_REVERB_SCHEME \
    INTERNAL_API_URL=$INTERNAL_API_URL

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=branding_builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=branding_builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=branding_builder /app/public ./public

USER nextjs

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

ENV PORT=3000 \
    HOSTNAME="0.0.0.0"

# server.js is created by next build from the standalone output
# https://nextjs.org/docs/pages/api-reference/next-config-js/output
CMD ["node", "server.js"]
