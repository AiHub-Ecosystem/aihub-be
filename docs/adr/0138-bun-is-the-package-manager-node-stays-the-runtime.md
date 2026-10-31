# ADR-0138: Bun is the package manager; Node.js stays the runtime

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-31 in [#342](https://github.com/AiHub-Ecosystem/aihub-be/issues/342).
- Date: 2026-10-31
- Amends: [ADR-0088](0088-prisma-for-control-plane-persistence.md) (the build paragraph names `.pnpmfile.cjs` and `pnpm why`; the guarantee it protects now rests on the Dockerfile and a CI check)
- Related: [ADR-0047](0047-nestjs-12-esm-only-framework.md), [ADR-0064](0064-ci-publishes-the-image-it-booted.md), [#342](https://github.com/AiHub-Ecosystem/aihub-be/issues/342), [#1434](https://github.com/AiHub-Ecosystem/aihub-be/issues/1434), [#228](https://github.com/AiHub-Ecosystem/aihub-be/issues/228)

## Context

AIHUB installed dependencies with pnpm 11.20.0. [#342](https://github.com/AiHub-Ecosystem/aihub-be/issues/342) ran a pilot of Bun 1.4.4 as the package manager only, on one `ubuntu-latest` runner with Node 22.23.4.

|                                          | pnpm                   | Bun                    |
| ---------------------------------------- | ---------------------- | ---------------------- |
| clean install, empty cache (median of 3) | 7.3–7.9 s              | 2.4–2.7 s              |
| clean install, warm cache (median of 3)  | 3.0–3.5 s              | 0.7 s                  |
| unit lane                                | 424 suites, 3995 tests | 424 suites, 3995 tests |
| Docker image build                       | 38 s                   | 35–36 s                |

Bun-installed dependencies passed `type-check`, `lint`, `build`, the audit gate, `argon2` and `@swc/core` under Node 22, and the Docker image boot. The only failure the pilot found was in the repository: two specs and `check-architecture.mjs` ran `pnpm` as a child process, which broke a Bun-installed `node_modules` while other workers were reading it.

The gain per run is small. The decision rests on one install tool across CI, Docker and local development, not on speed.

## Decision

Bun is the package manager. Node.js 22 remains the application runtime; running the application on Bun is a separate decision ([#228](https://github.com/AiHub-Ecosystem/aihub-be/issues/228)).

- `package.json` pins `bun@1.4.4` in `packageManager`; CI and the `Dockerfile` install the same version with `npm install --global bun@1.4.4`, because the repository allows only GitHub-owned actions and a short list of Docker actions, and `oven-sh/setup-bun` is not on it.
- `bun.lock` is the lockfile and `bun install --frozen-lockfile` the CI install. `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.pnpmfile.cjs` are gone.
- `trustedDependencies` lists the packages whose lifecycle scripts may run: `@biomejs/biome`, `@prisma/engines`, `@swc/core`, `argon2`, `esbuild`, `prisma`. This is the former `allowBuilds: true` set. `protobufjs` stays untrusted, as it was.
- The root `overrides` carry forward the four overrides from `pnpm-workspace.yaml`, each lifting a transitive dependency past an open advisory. Remove one once every package that forces the old version declares the patched one itself:
  - `js-yaml@>=4.0.0 <4.3.2` to `^4.3.2`: forced by `openapi-to-postmanv2`, which pins 4.3.0 exactly.
  - `yaml@>=1.0.0 <1.10.3` to `^1.10.3`: forced by `openapi-to-postmanv2`, which pins 1.10.2 exactly.
  - `uuid@<11.1.1` to `^11.1.1`: forced by `postman-collection`, which pins 8.3.2 exactly. A major jump; the committed Postman collection regenerates identically apart from its random ids. Its faker 5.5.3 pin is deliberately not overridden: faker 10 removed the API `postman-collection` loads ([ADR-0047](0047-nestjs-12-esm-only-framework.md)).
  - `brace-expansion@<1.1.21` to `^1.1.21`: forced by `minimatch` 3.1.5, which resolved the 1.x line to 1.1.18 and does not move on its own. 1.1.21 is the first release past the advisories, and `minimatch` 3 still accepts it (`^1.1.7`).
- Scripts and specs call Node, `tsx` and dependency-cruiser through `process.execPath`. A script that has to run a package script calls `bun run <script>` (`bun` is a real executable on every platform, so no shell is needed).
- Dependabot uses the `bun` ecosystem.

### The Prisma CLI stays out of the runtime image

[ADR-0088](0088-prisma-for-control-plane-persistence.md) kept the `prisma` CLI out of the production tree by dropping `@prisma/client`'s optional peer on it in `.pnpmfile.cjs`. Bun does not read that file. The `Dockerfile` now reinstalls with `bun install --frozen-lockfile --production --ignore-scripts`, which skips devDependencies, and the `Image boot` job fails if `node_modules/prisma` or `node_modules/.bin/prisma` is in the shipped image. The CLI remains a development dependency used only in the build stage.

## Consequences

- Installs are 3–5 s faster per CI job. Any job that needs dependencies installs them with the same command.
- Bun treats the first `--` after a script name as its own: `bun run test -- --watch` reaches the script as `--watch`. A `--` later in the argument list is forwarded. The test runner and `check:api-compatibility` already accept both forms.
- Bun prints `$ <command>` for each script and `error: script "<name>" exited with code N` on failure, not pnpm's `ELIFECYCLE`. `verify:summary` and `check:batch` read that format.
- Dependabot reads `package.json` and `bun.lock`; it does not evaluate the ranged selectors in `overrides`, so CI decides whether a proposed bump is acceptable.
- Bun's `node_modules` is flat. The `.pnpm` alternatives in the Jest `transformIgnorePatterns` are dead but harmless and stay for [ADR-0047](0047-nestjs-12-esm-only-framework.md).
- A cold `bun install` on a Windows developer machine took about three minutes in the migration; a warm one is much faster. Other installs, such as `bun audit`, were not timed on Windows.
- Reverting means restoring `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.pnpmfile.cjs` from history, switching `packageManager` back, and reverting the `bun run` spellings this change introduced.
