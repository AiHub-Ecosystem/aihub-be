FROM node:22.14.0-bookworm-slim AS dependencies

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

FROM node:22.14.0-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/lengocanh2005it/aihub-be"

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

RUN groupadd --system --gid 10001 aihub \
  && useradd --system --uid 10001 --gid 10001 --no-create-home aihub

COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/scripts/cli.mjs /app/scripts/cli-options.cjs /app/scripts/quota-reconcile.cjs ./scripts/
COPY --from=build --chown=10001:10001 /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=10001:10001 /app/database/migrations ./database/migrations

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/main.js"]
