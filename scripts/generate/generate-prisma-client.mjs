#!/usr/bin/env node
/**
 * Generates the Prisma client and makes it runnable from `dist/` (ADR-0088).
 *
 * `prisma generate` writes TypeScript sources into `dist/generated/prisma`,
 * outside `src/` and outside version control. Type-check and the test lanes read
 * those sources directly. The runtime image copies only `dist/`, and Node
 * cannot `require` a `.ts` file, so this script also compiles a runnable
 * `.js` beside every generated `.ts`. One specifier then serves both: TypeScript
 * picks up `client.ts`, Node picks up `client.js`.
 *
 * `@swc/cli` cannot write beside its own input, so it compiles into a staging
 * directory that is then moved into place. It runs after `nest build` so the
 * build output and the client end up in the same `dist/`.
 *
 * Fast path: when the inputs (schema, pinned prisma/@prisma/client versions)
 * are unchanged and the expected outputs exist, skip regeneration. The stamp
 * lives inside the generated directory, so deleting `dist/` or that directory
 * invalidates it, while `bun run build` keeps it (`clean-dist.cjs`, #1619) and
 * only a changed input regenerates. It also records the strongest mode that
 * produced the outputs: a plain request accepts runtime outputs, and a runtime
 * request over plain outputs only compiles, without `prisma generate`
 * (`prisma-client-stamp.cjs`, #1611).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  formatStamp,
  nextStamp,
  parseStamp,
  planGeneration,
} from './prisma-client-stamp.cjs';

const GENERATED = join('dist', 'generated', 'prisma');
const STAGING = join('dist', 'generated', '.staging');
const STAMP = join(GENERATED, '.stamp');
const reportTimings = process.argv.includes('--timings');
const runtime = process.argv.includes('--runtime');

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} command @param {string[]} args @param {string} phase @param {NodeJS.ProcessEnv} [env] */
function run(command, args, phase, env) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...(env ? { env } : {}),
  });
  if (reportTimings) {
    console.info(
      `[db-lane] ${phase}: ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
    );
  }

  if (result.status !== 0) {
    console.error(`${phase} failed: ${command} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

/** @returns {string} */
function computeInputHash() {
  const schema = readFileSync('prisma/schema.prisma');
  const parsed = /** @type {unknown} */ (
    JSON.parse(readFileSync('package.json', 'utf8'))
  );
  const pkg = isRecord(parsed) ? parsed : {};
  const dependencies = isRecord(pkg.dependencies) ? pkg.dependencies : {};
  const devDependencies = isRecord(pkg.devDependencies)
    ? pkg.devDependencies
    : {};
  /** @param {string} name @returns {string} */
  const dependencyVersion = (name) => {
    const version = dependencies[name] ?? devDependencies[name];
    return typeof version === 'string' ? version : '';
  };
  const prismaVersion = dependencyVersion('prisma');
  const clientVersion = dependencyVersion('@prisma/client');
  return createHash('sha256')
    .update(schema)
    .update(prismaVersion)
    .update(clientVersion)
    .digest('hex');
}

const hash = computeInputHash();
const stamp = existsSync(STAMP)
  ? parseStamp(readFileSync(STAMP, 'utf8'))
  : undefined;
const plan = planGeneration({
  runtime,
  hash,
  stamp,
  hasClientTs: existsSync(join(GENERATED, 'client.ts')),
  hasClientJs: existsSync(join(GENERATED, 'client.js')),
});
if (plan === 'skip') {
  console.log('[prisma-generate] inputs unchanged; skipping regeneration.');
  process.exit(0);
}

// Both CLIs run through their entry points: a package manager lays out `.bin`
// differently (Bun writes `swc.exe`, which `npx` does not resolve on Windows),
// and a shell would split a repository path at a space.
const require = createRequire(import.meta.url);
if (plan === 'generate') {
  rmSync(GENERATED, { force: true, recursive: true });
  // Prisma resolves generator providers from PATH; Bun lays its shims here.
  const generatorPath = join(process.cwd(), 'node_modules', '.bin');
  run(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'generate'],
    'Prisma client generation',
    {
      ...process.env,
      PATH: `${generatorPath}${delimiter}${process.env.PATH ?? ''}`,
    },
  );
}

if (runtime) {
  rmSync(STAGING, { force: true, recursive: true });
  run(
    process.execPath,
    [
      require.resolve('@swc/cli/bin/swc.js'),
      GENERATED,
      '--out-dir',
      STAGING,
      // A compile-only run finds `.js` from an earlier compile beside the
      // sources; compiling those too would collide with the new output.
      '--extensions',
      '.ts',
      '-C',
      'module.type=commonjs',
    ],
    'Prisma runtime compilation',
  );

  for (const entry of ['internal', 'models']) {
    const compiled = join(STAGING, 'dist', 'generated', 'prisma', entry);
    if (existsSync(compiled)) {
      cpSync(compiled, join(GENERATED, entry), { recursive: true });
    }
  }
  for (const file of [
    'browser.js',
    'client.js',
    'commonInputTypes.js',
    'enums.js',
    'models.js',
  ]) {
    const compiled = join(STAGING, 'dist', 'generated', 'prisma', file);
    if (existsSync(compiled)) {
      cpSync(compiled, join(GENERATED, file));
    }
  }

  rmSync(STAGING, { force: true, recursive: true });
}

const written = nextStamp(plan, runtime, hash, stamp);
if (written !== undefined) {
  writeFileSync(STAMP, formatStamp(written));
}
