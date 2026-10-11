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
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const GENERATED = join('dist', 'generated', 'prisma');
const STAGING = join('dist', 'generated', '.staging');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    console.error(
      `Prisma client generation failed: ${command} ${args.join(' ')}`,
    );
    process.exit(result.status ?? 1);
  }
}

const prisma = process.platform === 'win32' ? 'npx.cmd' : 'npx';
rmSync(GENERATED, { force: true, recursive: true });
run(prisma, ['prisma', 'generate']);

if (process.argv.includes('--runtime')) {
  rmSync(STAGING, { force: true, recursive: true });
  run(prisma, [
    'swc',
    GENERATED,
    '--out-dir',
    STAGING,
    '-C',
    'module.type=commonjs',
  ]);

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
