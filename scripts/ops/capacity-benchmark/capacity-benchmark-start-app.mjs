import { Buffer } from 'node:buffer';
import process from 'node:process';

const encodedKey = process.env.AIHUB_BENCHMARK_JWT_PRIVATE_KEY_B64;
if (encodedKey === undefined || encodedKey.length === 0) {
  throw new Error('benchmark JWT key was not provided');
}

process.env.AIHUB_USER_ACCESS_JWT_PRIVATE_KEY = Buffer.from(
  encodedKey,
  'base64',
).toString('utf8');
delete process.env.AIHUB_BENCHMARK_JWT_PRIVATE_KEY_B64;

if (process.argv[2] === 'scripts/cli/cli.mjs') {
  process.argv = [
    process.argv[0],
    '/app/scripts/cli/cli.mjs',
    ...process.argv.slice(3),
  ];
  await import('/app/scripts/cli/cli.mjs');
} else {
  await import('/app/scripts/runtime/runtime-entrypoint.mjs');
}
