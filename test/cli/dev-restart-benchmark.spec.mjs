import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  comparePhases,
  createWorkspace,
  withBenchmarkCleanup,
} from '../../scripts/ops/dev-restart-benchmark/benchmark.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const tempRoot = path.join(repositoryRoot, 'temp');

mkdirSync(tempRoot, { recursive: true });

await test('keeps probe files in an isolated workspace and links installed dependencies', async () => {
  const tempParent = mkdtempSync(path.join(tempRoot, 'dev-restart-test-'));
  const workspaceRoot = createWorkspace(repositoryRoot, tempParent);
  try {
    const probe = path.join(
      workspaceRoot,
      'src',
      'dev-restart-budget-probe.ts',
    );
    writeFileSync(probe, 'export const isolated = true;\n');
    assert.equal(
      existsSync(path.join(repositoryRoot, 'src', path.basename(probe))),
      false,
    );
    assert.equal(
      realpathSync(path.join(workspaceRoot, 'node_modules')),
      realpathSync(path.join(repositoryRoot, 'node_modules')),
    );
  } finally {
    await withBenchmarkCleanup({ workspaceRoot, tempParent }, async () => {});
  }
  assert.equal(existsSync(tempParent), false);
});

await test('stops the process tree and removes files when the benchmark fails', async () => {
  const tempParent = mkdtempSync(path.join(tempRoot, 'dev-restart-failure-'));
  const workspaceRoot = path.join(tempParent, 'workspace');
  mkdirSync(workspaceRoot);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  await once(child, 'spawn');

  await assert.rejects(
    withBenchmarkCleanup({ child, workspaceRoot, tempParent }, async () => {
      throw new Error('synthetic benchmark failure');
    }),
    /synthetic benchmark failure/,
  );
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(existsSync(tempParent), false);
});

await test(
  'kills remaining process group members after the leader exits on SIGTERM',
  { skip: process.platform === 'win32' },
  async (context) => {
    const tempParent = mkdtempSync(
      path.join(tempRoot, 'dev-restart-descendant-'),
    );
    const workspaceRoot = path.join(tempParent, 'workspace');
    mkdirSync(workspaceRoot);
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
          "descendant.once('spawn', () => process.stdout.write('ready'));",
          "process.on('SIGTERM', () => process.exit(0));",
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const ready = once(child.stdout, 'data');
    await once(child, 'spawn');
    await ready;
    assert.ok(child.pid !== undefined);
    const processGroupId = child.pid;
    context.after(() => {
      try {
        process.kill(-processGroupId, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });

    const groupIsAlive = () => {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    };

    await assert.rejects(
      withBenchmarkCleanup({ child, workspaceRoot, tempParent }, async () => {
        throw new Error('synthetic benchmark failure');
      }),
      /synthetic benchmark failure/,
    );
    assert.equal(groupIsAlive(), false);
  },
);
await test('fails a phase only when it exceeds its committed budget', () => {
  const results = comparePhases(
    { compile: 50, shutdown: 2501, boot: 3000 },
    {
      phases: {
        compile: { baselineMs: 95, budgetMs: 1500 },
        shutdown: { baselineMs: 1000, budgetMs: 2500 },
        boot: { baselineMs: 1700, budgetMs: 6000 },
      },
    },
  );
  assert.deepEqual(
    results.map(({ phase, passed }) => [phase, passed]),
    [
      ['compile', true],
      ['shutdown', false],
      ['boot', true],
    ],
  );
});

try {
  rmdirSync(tempRoot);
} catch (error) {
  if (
    error.code !== 'ENOENT' &&
    error.code !== 'ENOTEMPTY' &&
    error.code !== 'EEXIST'
  ) {
    throw error;
  }
}
