import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const repositoryRoot = process.cwd();
const temporaryRoot = join(repositoryRoot, 'temp');

function removeTemporaryRootIfCreated(createdByThisRun: boolean): void {
  if (!createdByThisRun) return;

  try {
    rmdirSync(temporaryRoot);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')
    ) {
      return;
    }
    throw error;
  }
}

export function lintFixture(
  source: string,
  options: {
    readonly fileName: string;
    readonly args: readonly string[];
    /** Lint from the fixture directory with a copy of the live config. */
    readonly configInFixture?: boolean;
  },
): { status: number | null; output: string } {
  const temporaryRootExisted = existsSync(temporaryRoot);
  mkdirSync(temporaryRoot, { recursive: true });
  const fixtureDirectory = mkdtempSync(join(temporaryRoot, 'lint-fixture-'));

  try {
    if (options.configInFixture === true) {
      copyFileSync(
        join(repositoryRoot, '.oxlintrc.json'),
        join(fixtureDirectory, '.oxlintrc.json'),
      );
    }
    const fixturePath = join(fixtureDirectory, options.fileName);
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, source, 'utf8');
    const result = spawnSync('bun', ['lint', ...options.args, fixturePath], {
      cwd: options.configInFixture === true ? fixtureDirectory : repositoryRoot,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });

    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
    removeTemporaryRootIfCreated(!temporaryRootExisted);
  }
}
