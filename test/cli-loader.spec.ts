import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Runner = (...args: readonly unknown[]) => unknown;

interface RunnerDescriptor {
  readonly builtPath: string;
  readonly sourcePath: string;
  readonly exportName: string;
  readonly unavailableMessage: string;
}

interface RunnerLoader {
  readonly loadCliRunner: (descriptor: RunnerDescriptor) => Promise<Runner>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunnerLoader(value: unknown): value is RunnerLoader {
  return isRecord(value) && typeof value.loadCliRunner === 'function';
}

const requireScript = createRequire(
  join(process.cwd(), 'test', 'cli-loader.spec.ts'),
);
const loaderModule: unknown = requireScript('../scripts/load-cli-runner.cjs');
if (!isRunnerLoader(loaderModule)) {
  throw new Error('generic CLI runner loader is unavailable');
}
const { loadCliRunner } = loaderModule;

async function withFixture<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'aihub-cli-loader-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('loadCliRunner', () => {
  it('prefers the built runner and caches it per descriptor', async () => {
    await withFixture(async (directory) => {
      const builtPath = join(directory, 'runner.js');
      const sourcePath = join(directory, 'runner.ts');
      await writeFile(
        builtPath,
        "module.exports = { default: { run: () => 'built' } };",
      );
      await writeFile(sourcePath, "export const run = () => 'source';");
      const descriptor: RunnerDescriptor = {
        builtPath,
        sourcePath,
        exportName: 'run',
        unavailableMessage: 'runner is unavailable',
      };

      const first = await loadCliRunner(descriptor);
      const second = await loadCliRunner(descriptor);

      expect(first).toBe(second);
      expect(first()).toBe('built');
    });
  });

  it('uses the descriptor-specific unavailable message', async () => {
    await withFixture(async (directory) => {
      const builtPath = join(directory, 'runner.js');
      await writeFile(builtPath, 'module.exports = { default: null };');

      await expect(
        loadCliRunner({
          builtPath,
          sourcePath: join(directory, 'missing.ts'),
          exportName: 'run',
          unavailableMessage: 'usage report command is unavailable',
        }),
      ).rejects.toThrow('usage report command is unavailable');
    });
  });

  it('falls back to all six TypeScript sources when built paths are absent', async () => {
    const loaderPath = join(process.cwd(), 'scripts', 'load-cli-runner.cjs');
    const sourceRunners = [
      ['organization-status.ts', 'runOrganizationStatusCommand'],
      ['organization-first-owner.ts', 'runAttachFirstOwnerCommand'],
      ['usage-prune.ts', 'runUsagePruneCommand'],
      ['usage-report.ts', 'runUsageReportCommand'],
      ['quota-reconcile.ts', 'runQuotaReconciliationCommand'],
      ['quota-reconcile.ts', 'parseTargetMonth'],
    ] as const;
    const descriptors = sourceRunners.map(([file, exportName]) => ({
      builtPath: join(process.cwd(), 'dist', 'missing-cli-runner.js'),
      sourcePath: join(process.cwd(), 'src', 'cli', file),
      exportName,
      unavailableMessage: 'runner is unavailable',
    }));
    const script = `
      const { loadCliRunner } = require(${JSON.stringify(loaderPath)});
      Promise.all(${JSON.stringify(descriptors)}.map((descriptor) => loadCliRunner(descriptor)))
        .then((runners) => {
          process.exit(runners.every((runner) => typeof runner === 'function') ? 0 : 1);
        });
    `;

    const status = await new Promise<number>((resolve) => {
      execFile(process.execPath, ['-e', script], (error) => {
        resolve(
          typeof error?.code === 'number' ? error.code : error === null ? 0 : 1,
        );
      });
    });

    expect(status).toBe(0);
  }, 30_000);
});
