# Running the verification loop

Read this before starting a full `bun run verify` loop, and whenever a run dies with a worker or heap error.

The default `bun run test` and `bun run verify` unit lane uses Bun 1.4.4-canary.20261109.1 with per-file isolation and `--smol`. CI also runs `bun run coverage:unit` with Jest and SWC because its Istanbul report supplies branch records required by the merged-coverage gate. The Jest coverage lane is memory-bound on a developer machine, not worker-bound. `jest.config.cjs` caps it at two workers, and the database lanes run `--runInBand` behind a Postgres advisory lane lock, so two concurrent `bun run test:db` invocations wait for each other instead of interleaving. CI runs the same coverage and database scripts under the same caps, so there is no lower-worker CI mode to fall back on.

Check free memory before running `bun run coverage:unit`. Jest lowers its worker count from measured free memory (`scripts/checks/jest/jest-worker-cap.cjs`: a two GiB per worker budget, never above the two it replaces, never below one) and prints one warning line when it does. With less than 4 GiB free it uses one worker; otherwise it uses two. Proceed with `bun run verify` without asking for confirmation or deferring it solely because free RAM is low. Pin a count with `AIHUB_JEST_MAX_WORKERS` when you know the machine better than the budget does; an unusable value fails at config load, not silently. One worker can still exhaust memory on a saturated host; if that happens, follow the worker/heap-death procedure in `AGENTS.md` and report the run as inconclusive. Setting `NODE_OPTIONS=--max-old-space-size` helps only while physical memory remains; on a saturated host it postpones the crash and makes it larger.

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

## Multi-commit branch verification

When a pull request delivers multiple ordered commits, every intermediate commit must remain bisect-friendly and compile independently. Run `git rebase --exec "bunx tsc --noEmit" <base>` across the branch range before opening the pull request to verify that intermediate commits do not have broken imports.

## What verify leaves to CI (#1786)

A green `bun run verify` is not the whole gate. Three areas deliberately stay CI-side, each with a named owner; a contributor green on `verify` can still fail CI on them:

- **The database lane** — `test:db`, `test:tenant-isolation`, `coverage:db`, `coverage:tenant-isolation` — and **`check:prisma-drift`** run in CI's `database` job, not in `verify`. They need a Postgres the lane can prove is AIHUB's (see "Running one database-lane spec" above) and would make the default loop fragile on machines whose Postgres and Redis belong to another project. Run the lane by hand before handoff when the change touches a database path; `check:changed` selects `test` for Prisma and migration changes.
- **The Jest coverage thresholds** — the `coverageThreshold` in `jest.config.cjs` (lines 83 / branches 72) is enforced by `bun run coverage:unit`, which CI's `coverage` job runs. The decision recorded here is that the threshold stays CI-side: `verify` runs the unit lane without coverage, and adding an Istanbul instrumented run to every local loop would roughly double its cost and run the memory-bound lane on every developer machine for a number the merged-coverage gate already answers. The `coverage` job fails a drop past the agreed margin against the committed baseline, not the absolute floor; the floor still bounds the baseline itself.
- **The commit-message range** — the `.husky/commit-msg` gate runs at hook time, and `bun run verify` never re-checks committed history. CI's `static` job lints the pull request range or the push range through the hook script itself (`scripts/ci/commit-messages/check-commit-messages.mjs`), so a `--no-verify` commit is caught there.

Everything else `verify` covers stays as it is; nothing above removes, weakens, or makes optional a step `verify` already runs.

## Windows cross-drive worktrees and lint-staged backup

On Windows, when a Git worktree sits on a different drive than the primary repository Git directory (e.g. `C:\...` worktree pointing to `D:\aihub-be\.git`), `lint-staged`'s automatic stash backup in Husky's pre-commit hook can fail with `✖ Failed to back up original state!`.

When this happens:

1. Verify staged files directly: `bunx lint-staged`.
2. Run `bun run check:changed`.
3. Commit with `--no-verify`.
4. Validate the commit message immediately with `git log -1 --format=%B | node scripts/checks/hooks/commit-message.mjs`.
