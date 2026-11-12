import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStagedCommandEnv,
  parseStagedPaths,
  runStagedChecks,
} from './check-staged.mjs';

await test('parses staged paths as NUL-delimited names', () => {
  assert.deepEqual(
    parseStagedPaths('src/a.ts\0docs/a guide.md\0test/line\nbreak.spec.mjs\0'),
    ['src/a.ts', 'docs/a guide.md', 'test/line\nbreak.spec.mjs'],
  );
});

await test('checks only staged source files and finds their related Jest tests', () => {
  const calls = [];
  const exitCode = runStagedChecks({
    stagedFiles: [
      'README.md',
      'src/feature.ts',
      'scripts/checks/example.mjs',
      'test/feature.spec.ts',
    ],
    runCommand: (command, args, options) => {
      calls.push([command, args, options]);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    [
      process.execPath,
      [
        'lint',
        '--no-script',
        '--type-aware',
        '--threads=1',
        '--format=unix',
        '--tsconfig',
        'tsconfig.json',
        'src/feature.ts',
        'test/feature.spec.ts',
      ],
      undefined,
    ],
    [
      process.execPath,
      [
        'lint',
        '--no-script',
        '--type-aware',
        '--threads=1',
        '-A',
        'all',
        '-D',
        'typescript/no-floating-promises',
        '--format=unix',
        'scripts/checks/example.mjs',
      ],
      undefined,
    ],
    [
      process.execPath,
      [
        'x',
        'jest',
        '--findRelatedTests',
        '--coverage=false',
        '--passWithNoTests',
        '--runInBand',
        'src/feature.ts',
        'scripts/checks/example.mjs',
        'test/feature.spec.ts',
      ],
      {
        env: {
          REDIS_URL: undefined,
          DATABASE_URL: undefined,
        },
      },
    ],
  ]);
});

await test('staged documentation skips source lint and Jest', () => {
  const calls = [];
  const exitCode = runStagedChecks({
    stagedFiles: ['README.md', 'docs/guide.yaml'],
    runCommand: (command, args) => {
      calls.push([command, args]);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
});

await test('an empty staged set runs no commands', () => {
  const calls = [];
  const exitCode = runStagedChecks({
    stagedFiles: [],
    runCommand: (...args) => calls.push(args),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, []);
});

await test('stops after the first failing staged check', () => {
  const calls = [];
  const exitCode = runStagedChecks({
    stagedFiles: ['src/feature.ts'],
    runCommand: (command, args) => {
      calls.push([command, args]);
      return calls.length === 1 ? 1 : 0;
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, [
    [
      process.execPath,
      [
        'lint',
        '--no-script',
        '--type-aware',
        '--threads=1',
        '--format=unix',
        '--tsconfig',
        'tsconfig.json',
        'src/feature.ts',
      ],
    ],
  ]);
});

await test('spawns Jest with REDIS_URL and DATABASE_URL stripped from env (#1894)', () => {
  let jestOptions;
  runStagedChecks({
    stagedFiles: ['src/feature.ts'],
    runCommand: (_cmd, args, options) => {
      if (args[1] === 'jest') jestOptions = options;
      return 0;
    },
  });

  assert.deepEqual(jestOptions, {
    env: {
      REDIS_URL: undefined,
      DATABASE_URL: undefined,
    },
  });
});

await test('buildStagedCommandEnv deletes keys set to undefined (#1894)', () => {
  const customEnv = buildStagedCommandEnv({
    env: {
      REDIS_URL: undefined,
      DATABASE_URL: undefined,
      TEST_STAGED_KEY: 'preserved',
    },
  });

  assert.equal(customEnv['REDIS_URL'], undefined);
  assert.equal(customEnv['DATABASE_URL'], undefined);
  assert.equal(customEnv['TEST_STAGED_KEY'], 'preserved');
  assert.equal(customEnv['GOMAXPROCS'], '1');
});
