# syntax=docker/dockerfile:1.7
#
# octora-api production image (P1-41).
#
# Two-stage build:
#   - builder  : full dev deps + prisma generate
#   - runtime  : node:alpine, non-root user, only the artifacts we need
#                to run `tsx src/index.ts`
#
# We ship `tsx` rather than running a separate `tsc` build because the
# package.json `imports` field maps the `#…` subpath aliases to source
# `.js` paths that only resolve correctly under tsx's loader. Saves the
# build complexity and the Node startup is only marginally slower (this
# is a long-lived API, not a CLI).
#
# Build context is `octora-api/` — the repo has no pnpm workspace
# root, so each package has its own lockfile.

ARG NODE_VERSION=20.18-alpine

# ─────────────────────────── builder ───────────────────────────
FROM node:${NODE_VERSION} AS builder

# pnpm + system deps used by prisma's binary engine fallback.
RUN corepack enable \
 && corepack prepare pnpm@10.0.0 --activate \
 && apk add --no-cache openssl

WORKDIR /app

# Layer dep install separately from source so a code-only diff hits
# the BuildKit cache.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Prisma schema must be present BEFORE generate; copy explicitly so a
# stale cache layer can't reuse a generated client whose schema is out
# of date.
COPY prisma ./prisma
RUN pnpm exec prisma generate

# Copy the rest of the source.
COPY src ./src
COPY tsconfig.json ./

# Surface a typecheck failure here rather than at runtime — a botched
# build is an immediate fail-fast, not a 3am page.
RUN pnpm exec tsc -p tsconfig.json --noEmit

# ─────────────────────────── runtime ───────────────────────────
FROM node:${NODE_VERSION} AS runtime

RUN apk add --no-cache openssl wget tini

# Run as a non-root user. The audit (P1-41) is explicit about this —
# a containerized exploit on root inside the API can pivot harder than
# the same exploit on a UID-1001 process whose only mounts are read-
# only artifacts.
RUN addgroup -S octora && adduser -S octora -G octora

WORKDIR /app

# Copy installed deps + generated prisma client + source. We DO NOT
# copy package-manager state (pnpm metadata, lockfile), the runtime
# never installs anything.
COPY --from=builder --chown=octora:octora /app/node_modules ./node_modules
COPY --from=builder --chown=octora:octora /app/prisma ./prisma
COPY --from=builder --chown=octora:octora /app/src ./src
COPY --from=builder --chown=octora:octora /app/package.json ./package.json
COPY --from=builder --chown=octora:octora /app/tsconfig.json ./tsconfig.json

USER octora

# Default port; override via PORT env var.
ENV NODE_ENV=production \
    PORT=8787

EXPOSE 8787

# wget is intentionally already installed (apk above) so the healthcheck
# doesn't depend on curl. /health returns 503 on any failed dependency,
# which Docker treats as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${PORT}/health || exit 1

# tini reaps zombies and forwards signals so a `docker stop` results in
# a graceful Fastify shutdown.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
