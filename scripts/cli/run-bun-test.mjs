import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /\.(?:spec|test)\.tsx?$/;
const BASE_ARGS = [
  '--isolate',
  '--smol',
  '--dots',
  '--timeout=30000',
  '--preload',
  './test/runtime-secret-env.ts',
  '--preload',
  './test/silence-nest-logger.ts',
  '--preload',
  './test/support/bun-jest-compat.ts',
  '--path-ignore-patterns=test/db/**',
];

/** @param {string[]} args */
export function buildBunTestArgs(args) {
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  const filters = forwarded.filter((arg) => TEST_FILE.test(arg));
  const options = forwarded.filter((arg) => !TEST_FILE.test(arg));

  return [
    'test',
    ...BASE_ARGS,
    ...options,
    ...(filters.length ? filters : ['.spec.ts']),
  ];
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const result = spawnSync('bun', buildBunTestArgs(process.argv.slice(2)), {
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
