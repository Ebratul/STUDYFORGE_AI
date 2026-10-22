# syntax=docker/dockerfile:1
# StudyForge backend (Hono API + in-process job worker). Build context: ./backend
#   docker build -t studyforge-backend:ci backend
# Targets:  runtime (default, last stage)  |  migrate (one-off `prisma migrate deploy`; never run automatically)
# All configuration is injected at RUNTIME via environment variables (see .env.example). Nothing secret is baked into an image.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ---- dependencies (cached on the lockfile) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

# ---- build: generate the Prisma client, compile TypeScript ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm prisma generate && pnpm build

# ---- migrate: has the Prisma CLI + migrations. Run manually / from CD with DATABASE_URL set. ----
FROM build AS migrate
USER node
CMD ["pnpm", "prisma", "migrate", "deploy"]

# ---- production dependencies only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Local file storage lives here when STORAGE_DRIVER=local; mount a volume (or use STORAGE_DRIVER=s3).
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
