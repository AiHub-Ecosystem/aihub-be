# Running the verification loop

Read this before starting a full `pnpm verify` loop, and whenever a run dies with a worker or heap error.

The unit lane is memory-bound on a developer machine, not worker-bound. `jest.config.cjs` caps it at two workers, and the database lanes run `--runInBand` behind a Postgres advisory lane lock, so two concurrent `pnpm test:db` invocations wait for each other instead of interleaving. CI runs the same scripts under the same caps, so there is no lower-worker CI mode to fall back on. Measured 2026-10-20: 310 suites in the unit lane (`pnpm test -- --listTests`), each worker booting Nest DI, SWC, and the Prisma client.

Check free memory before starting a full loop. The unit lane lowers its own worker count from measured free memory (`scripts/checks/jest-worker-cap.cjs`: a two GiB per worker budget, never above the two it replaces, never below one) and prints one warning line when it does, so a slowed run is explained rather than mistaken for a hang. Pin a count with `AIHUB_JEST_MAX_WORKERS` when you know the machine better than the budget does; an unusable value fails at config load, not silently. Lowering `maxWorkers` is still no substitute for capacity: when only a few gigabytes are free, prefer the narrow gates and leave `pnpm verify` until the machine is quieter. Setting `NODE_OPTIONS=--max-old-space-size` helps only while physical memory remains; on a saturated host it postpones the crash and makes it larger.

Run one full loop at a time on a machine. Concurrent agents double the resident workers, and that overlap, not the code under test, is the usual source of a heap death here.
