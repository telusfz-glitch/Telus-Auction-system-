# syntax=docker/dockerfile:1.7
# API image (build context: repository root). Targets:
#   runtime (default) — the API:        CMD node apps/api/dist/main.js
#                       migrations:     node apps/api/dist/db/migrate.js   (run as the OWNER role, one-off task)
#   ops               — + PostgreSQL 16 client and scripts/db (backup.sh, restore-drill.sh) for scheduled jobs.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @telus/api

FROM ${NODE_IMAGE} AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts --workspace=@telus/api --include-workspace-root

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=root:root /repo/node_modules ./node_modules
COPY --from=deps /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
# At runtime the shared package is its compiled JavaScript, not its TypeScript source.
RUN sed -i 's#"main": "src/index.ts"#"main": "dist/index.js"#; s#"types": "src/index.ts"#"types": "dist/index.d.ts"#' packages/shared/package.json \
 && rm -rf node_modules/@telus && mkdir -p node_modules/@telus && ln -s ../../packages/shared node_modules/@telus/shared
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/db ./apps/api/db
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS ops
USER root
# PostgreSQL 16 client from the PostgreSQL project's signed repository (pg_dump must match the server's major version).
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg lsb-release >/dev/null \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends postgresql-client-16 >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/db ./scripts/db
USER node
CMD ["bash", "-c", "echo 'ops image: run scripts/db/backup.sh or scripts/db/restore-drill.sh' && exit 64"]
