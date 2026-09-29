# syntax=docker/dockerfile:1.7
# Web app image (build context: repository root): the Next.js standalone server. All settings come from the environment
# at runtime (see apps/web/src/lib/env.ts); nothing secret is baked into the image.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @telus/web

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
