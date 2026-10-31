# Pinned by digest so two builds of one commit cannot differ by a base image
# repoint. Bump when Node publishes a security patch for this version, or
# monthly, whichever comes first (ADR-0064).
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS dependencies

WORKDIR /app

# Bun installs the dependencies; Node stays the runtime. Installed with npm
# because the base image ships Node and npm, not Bun.
RUN npm install --global bun@1.4.4

COPY package.json bun.lock ./
RUN HUSKY=0 bun install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN bun run build
# A production reinstall, not a prune: Bun has no prune, and the reinstall keeps the
# `prisma` CLI out of the image because it is a devDependency (ADR-0088).
RUN rm -rf node_modules && HUSKY=0 bun install --frozen-lockfile --production --ignore-scripts

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime

# Pinned by digest so two builds of one commit cannot differ by a base image
# repoint. Bump when Node publishes a security patch for this version, or
# monthly, whichever comes first (ADR-0064).
#
# `revision` is the commit the running image came from. The deployed checkout
# has no `.git`, so without this label `docker inspect` cannot tell an operator
# which commit is live, and an incident starts with guessing.
ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/AiHub-Ecosystem/aihub-be" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production \
    OTEL_NODE_EXPERIMENTAL_SDK_METRICS=true \
    PORT=3000 \
    UV_THREADPOOL_SIZE=4

WORKDIR /app

RUN groupadd --system --gid 10001 aihub \
  && useradd --system --uid 10001 --gid 10001 --no-create-home aihub

COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/scripts/cli/cli.mjs /app/scripts/cli/cli-options.cjs /app/scripts/cli/load-cli-runner.cjs ./scripts/cli/
COPY --from=build --chown=10001:10001 /app/scripts/cli/migrate.mjs ./scripts/cli/migrate.mjs
COPY --from=build --chown=10001:10001 /app/scripts/ops/monitoring/probe-runtime-dependencies.cjs ./scripts/ops/monitoring/probe-runtime-dependencies.cjs
COPY --from=build --chown=10001:10001 /app/scripts/runtime/runtime-entrypoint.mjs ./scripts/runtime/runtime-entrypoint.mjs
COPY --from=build --chown=10001:10001 /app/prisma/migrations ./prisma/migrations

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "scripts/runtime/runtime-entrypoint.mjs"]
