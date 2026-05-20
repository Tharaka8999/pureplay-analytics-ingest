# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: install production dependencies only
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: build TypeScript
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3a: API process
# Memory: 512 MB container limit → reserve 384 MB for V8 heap
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS api

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY migrations ./migrations

USER appuser

ENV NODE_OPTIONS="--max-old-space-size=384"

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

EXPOSE 3000
CMD ["node", "dist/main.api.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3b: Worker process
# Memory: 512 MB container limit → reserve 384 MB for V8 heap
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS worker

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY migrations ./migrations

USER appuser

ENV NODE_OPTIONS="--max-old-space-size=384"

CMD ["node", "dist/main.worker.js"]
