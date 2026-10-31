# Running the verification loop

Read this before starting a full `bun run verify` loop, and whenever a run dies with a worker or heap error.

The default `bun run test` and `bun run verify` unit lane uses Bun 1.4.4 with per-file isolation and `--smol`. CI also runs `bun run coverage:unit` with Jest and SWC because its Istanbul report supplies branch records required by the merged-coverage gate. The Jest coverage lane is memory-bound on a developer machine, not worker-bound. `jest.config.cjs` caps it at two workers, and the database lanes run `--runInBand` behind a Postgres advisory lane lock, so two concurrent `bun run test:db` invocations wait for each other instead of interleaving. CI runs the same coverage and database scripts under the same caps, so there is no lower-worker CI mode to fall back on.

Check free memory before running `bun run coverage:unit`. Jest lowers its worker count from measured free memory (`scripts/checks/jest-worker-cap.cjs`: a two GiB per worker budget, never above the two it replaces, never below one) and prints one warning line when it does. With less than 4 GiB free it uses one worker; otherwise it uses two. Proceed with `bun run verify` without asking for confirmation or deferring it solely because free RAM is low. Pin a count with `AIHUB_JEST_MAX_WORKERS` when you know the machine better than the budget does; an unusable value fails at config load, not silently. One worker can still exhaust memory on a saturated host; if that happens, follow the worker/heap-death procedure in `AGENTS.md` and report the run as inconclusive. Setting `NODE_OPTIONS=--max-old-space-size` helps only while physical memory remains; on a saturated host it postpones the crash and makes it larger.

Run one full loop at a time on a machine. Concurrent agents double the resident workers, and that overlap, not the code under test, is the usual source of a heap death here.

## Reading a red CI run

`gh run view <run> --log-failed` shows only the aggregate `CI` job, which holds `STATIC_RESULT: failure` and no cause. Find the failing job, then read its log:

1. `gh pr checks <pr>` (or `gh run view <run> --json jobs`) lists each job with its id; take the one marked fail.
2. `gh run view <run> --job <id> --log`, filtered to the first failing step (`| grep -n -m1 -B5 -A40 'error\|FAIL'`).

## Running one database-lane spec

`bun run test:db` needs a Postgres the lane can prove is AIHUB's. On a machine whose ports 5432 and 6379 belong to another project, run one spec against a throwaway container:

1. Start it on a free port and wait for `pg_isready`: `docker run -d --name aihub-lane-tmp -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -p 5441:5432 postgres:16`.
2. Mark it as the lane's: `docker exec aihub-lane-tmp psql -U postgres -c "ALTER DATABASE postgres SET aihub.test_lane_marker = 'aihub_db_lane_v1'"`. Without the marker the lane stops with "does not point to an AIHUB-owned PostgreSQL service".
3. Generate the runtime client: `node scripts/generate/generate-prisma-client.mjs --runtime`.
4. Run it: `DB_LANE_ADMIN_URL=postgres://postgres:postgres@localhost:5441/postgres AIHUB_JEST_MAX_WORKERS=1 npx jest --config jest.config.db.cjs --runInBand <spec-pattern>`.
5. Remove the container, then run `bun run lint` before any `bun run verify`: the lane regenerates `dist/generated/prisma` in runtime mode, and lint regenerates the plain client that type-aware lint needs.

Specs that need Redis fail with `ECONNREFUSED` when no throwaway Redis exists; that is the environment, not the code. Do not run the lane while `bun run verify` runs, since both write `dist/generated/prisma`.
