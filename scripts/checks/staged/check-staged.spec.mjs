import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStagedPaths, runStagedChecks } from './check-staged.mjs';

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
    runCommand: (command, args) => {
      calls.push([command, args]);
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    [
      'bun',
      [
        'run',
        'oxlint',
        '--type-aware',
        '--threads=1',
        '--tsconfig',
        'tsconfig.json',
        'src/feature.ts',
        'test/feature.spec.ts',
      ],
    ],
    [
      'bun',
      [
        'run',
        'oxlint',
        '--type-aware',
        '--threads=1',
        '-A',
        'all',
        '-D',
        'typescript/no-floating-promises',
        'scripts/checks/example.mjs',
      ],
    ],
    [
      'bun',
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
      'bun',
      [
        'run',
        'oxlint',
        '--type-aware',
        '--threads=1',
        '--tsconfig',
        'tsconfig.json',
        'src/feature.ts',
      ],
    ],
  ]);
});
