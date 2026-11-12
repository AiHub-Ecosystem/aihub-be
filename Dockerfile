# Pinned by digest so two builds of one commit cannot differ by a base image
# repoint. Bump when Node publishes a security patch for this version, or
# monthly, whichever comes first (ADR-0064).
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f8f9d41e9d635a72f08b1ee0bd274f90b11606c5d48e925b89458e AS base

ENV PRISMA_SKIP_POSTINSTALL_GENERATE=1 \
    NPM_CONFIG_IGNORE_SCRIPTS=true

WORKDIR /app

# Bun installs the dependencies; Node stays the runtime. Installed with npm
# because the base image ships Node and npm, not Bun.
RUN npm install --global bun@1.4.4-canary.20261109.1

# Production dependencies from manifests only so this layer stays cached until
# package.json or bun.lock changes. Husky stays off because its prepare hook
# is not needed for a production install.
FROM base AS prod-deps

COPY package.json bun.lock ./

RUN HUSKY=0 bun install --frozen-lockfile --production

# Full install (including dev dependencies) for building the application.
FROM base AS builder

COPY package.json bun.lock ./

RUN HUSKY=0 bun install --frozen-lockfile

COPY . .

RUN bun run build

# Runtime image: production node_modules from prod-deps plus build output from
# builder. Bun and dev dependencies do not ship here.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f8f9d41e9d635a72f08b1ee0bd274f90b11606c5d48e925b89458e AS runtime

ENV PRISMA_SKIP_POSTINSTALL_GENERATE=1 \
    NPM_CONFIG_IGNORE_SCRIPTS=true

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts/runtime ./scripts/runtime

# Non-root runtime user. /app is root-owned and read-only at runtime except
# for subtrees that future writable-volume work (#1188) will mount; for now
# the app writes only to stdout. Read-only mounts for dist, secrets, and
# /tmp are runtime policy and land in the deployment manifests, not here.
RUN groupadd --system --gid 1001 aihub \
  && useradd --system --uid 1001 --gid 1001 --home-dir /app --no-create-home --shell /usr/sbin/nologin aihub \
  && chown -R aihub:aihub /app

USER aihub

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "scripts/runtime/runtime-entrypoint.mjs"]