FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci && (npm audit fix || true)
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
RUN apk update && apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn*
WORKDIR /app
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 5001
CMD ["node", "dist/server.js"]
