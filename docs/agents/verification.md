# Running the verification loop

Read this before starting a full `pnpm verify` loop, and whenever a run dies with a worker or heap error.

The unit lane is memory-bound on a developer machine, not worker-bound. `jest.config.cjs` caps it at two workers, and the database lanes run `--runInBand` behind a Postgres advisory lane lock, so two concurrent `pnpm test:db` invocations wait for each other instead of interleaving. CI runs the same scripts under the same caps, so there is no lower-worker CI mode to fall back on. Measured 2026-10-20: 310 suites in the unit lane (`pnpm test -- --listTests`), each worker booting Nest DI, SWC, and the Prisma client.

Check free memory before starting a full loop. The unit lane lowers its own worker count from measured free memory (`scripts/checks/jest-worker-cap.cjs`: a two GiB per worker budget, never above the two it replaces, never below one) and prints one warning line when it does, so a slowed run is explained rather than mistaken for a hang. Pin a count with `AIHUB_JEST_MAX_WORKERS` when you know the machine better than the budget does; an unusable value fails at config load, not silently. Lowering `maxWorkers` is still no substitute for capacity: when only a few gigabytes are free, prefer the narrow gates and leave `pnpm verify` until the machine is quieter. Setting `NODE_OPTIONS=--max-old-space-size` helps only while physical memory remains; on a saturated host it postpones the crash and makes it larger.

Run one full loop at a time on a machine. Concurrent agents double the resident workers, and that overlap, not the code under test, is the usual source of a heap death here.

## Running one database-lane spec

`pnpm test:db` needs a Postgres the lane can prove is AIHUB's. On a machine whose ports 5432 and 6379 belong to another project, run one spec against a throwaway container:

1. Start it on a free port and wait for `pg_isready`: `docker run -d --name aihub-lane-tmp -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -p 5441:5432 postgres:16`.
2. Mark it as the lane's: `docker exec aihub-lane-tmp psql -U postgres -c "ALTER DATABASE postgres SET aihub.test_lane_marker = 'aihub_db_lane_v1'"`. Without the marker the lane stops with "does not point to an AIHUB-owned PostgreSQL service".
3. Generate the runtime client: `node scripts/generate/generate-prisma-client.mjs --runtime`.
4. Run it: `DB_LANE_ADMIN_URL=postgres://postgres:postgres@localhost:5441/postgres AIHUB_JEST_MAX_WORKERS=1 npx jest --config jest.config.db.cjs --runInBand <spec-pattern>`.
5. Remove the container, then run `pnpm lint` before any `pnpm verify`: the lane regenerates `dist/generated/prisma` in runtime mode, and lint regenerates the plain client that type-aware lint needs.

Specs that need Redis fail with `ECONNREFUSED` when no throwaway Redis exists; that is the environment, not the code. Do not run the lane while `pnpm verify` runs, since both write `dist/generated/prisma`.
