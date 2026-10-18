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
 * directory that is then moved into place. It runs after `nest build` because
 * that builder deletes `dist/`.
 *
 * Fast path: when the inputs (schema, pinned prisma/@prisma/client versions,
 * and the --runtime mode) are unchanged and the expected outputs exist, skip
 * regeneration. The stamp lives inside the generated directory so that a
 * `pnpm build` (which deletes `dist/`) naturally invalidates it.
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
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const GENERATED = join('dist', 'generated', 'prisma');
const STAGING = join('dist', 'generated', '.staging');
const STAMP = join(GENERATED, '.stamp');
const reportTimings = process.argv.includes('--timings');
const runtime = process.argv.includes('--runtime');

function run(command, args, phase) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
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

function computeStamp() {
  const schema = readFileSync('prisma/schema.prisma');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const prismaVersion =
    pkg.dependencies?.prisma ?? pkg.devDependencies?.prisma ?? '';
  const clientVersion =
    pkg.dependencies?.['@prisma/client'] ??
    pkg.devDependencies?.['@prisma/client'] ??
    '';
  return createHash('sha256')
    .update(schema)
    .update(prismaVersion)
    .update(clientVersion)
    .update(runtime ? 'runtime' : 'plain')
    .digest('hex');
}

function expectedOutputsExist() {
  if (!existsSync(join(GENERATED, 'client.ts'))) return false;
  if (runtime && !existsSync(join(GENERATED, 'client.js'))) return false;
  return true;
}

const stamp = computeStamp();
if (
  existsSync(STAMP) &&
  readFileSync(STAMP, 'utf8').trim() === stamp &&
  expectedOutputsExist()
) {
  console.log('[prisma-generate] inputs unchanged; skipping regeneration.');
  process.exit(0);
}

const prisma = process.platform === 'win32' ? 'npx.cmd' : 'npx';
rmSync(GENERATED, { force: true, recursive: true });
run(prisma, ['prisma', 'generate'], 'Prisma client generation');

if (runtime) {
  rmSync(STAGING, { force: true, recursive: true });
  run(
    prisma,
    ['swc', GENERATED, '--out-dir', STAGING, '-C', 'module.type=commonjs'],
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

writeFileSync(STAMP, stamp + '\n');
