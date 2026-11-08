# Build context is the repo root (deploy/compose.yml): the dashboard needs the workspace lockfile, the factory
# modules it imports as software-factory/* (package.json exports), targets/ and seams.yml (the chat's model).
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/
RUN pnpm install --frozen-lockfile --filter factory-dashboard...
COPY factory/run-events.ts factory/thresholds.ts factory/factory-file.ts factory/relay.ts factory/
COPY factory/adapters/model-call.ts factory/adapters/
COPY targets targets
COPY dashboard dashboard
RUN pnpm --filter factory-dashboard build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 \
    TARGETS_DIR=/app/targets DASHBOARD_DB=/data/factory.db BACKUP_DIR=/data/backups SEAMS_FILE=/app/seams.yml
COPY --from=build --chown=node:node /app/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /app/dashboard/.next/static dashboard/.next/static
COPY --from=build /app/targets targets
COPY seams.yml ./
# The compose volume takes this owner when it is first created.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dashboard/server.js"]
