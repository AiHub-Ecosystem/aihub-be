# Pinned by digest so two builds of one commit cannot differ by a base image
# repoint. Bump when Node publishes a security patch for this version, or
# monthly, whichever comes first (ADR-0064).
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS dependencies

WORKDIR /app
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable \
  && corepack install --global pnpm@11.20.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN HUSKY=0 pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN pnpm build
RUN pnpm prune --prod --ignore-scripts

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
COPY --from=build --chown=10001:10001 /app/scripts/ops/probe-runtime-dependencies.cjs ./scripts/ops/probe-runtime-dependencies.cjs
COPY --from=build --chown=10001:10001 /app/scripts/runtime/runtime-entrypoint.mjs ./scripts/runtime/runtime-entrypoint.mjs
COPY --from=build --chown=10001:10001 /app/database/migrations ./database/migrations

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "scripts/runtime/runtime-entrypoint.mjs"]
