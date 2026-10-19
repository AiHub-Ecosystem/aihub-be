import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = process.cwd();
const temporaryRoot = join(repositoryRoot, 'temp');
const oxlintCli = join(
  repositoryRoot,
  'node_modules',
  'oxlint',
  'bin',
  'oxlint',
);

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

function lintFixture(source: string): {
  status: number | null;
  output: string;
} {
  const temporaryRootExisted = existsSync(temporaryRoot);
  mkdirSync(temporaryRoot, { recursive: true });
  const fixtureDirectory = mkdtempSync(join(temporaryRoot, 'expect-expect-'));

  try {
    const fixturePath = join(fixtureDirectory, 'expect-expect.spec.ts');
    writeFileSync(fixturePath, source, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        oxlintCli,
        '--config',
        join(repositoryRoot, '.oxlintrc.json'),
        '--no-ignore',
        fixturePath,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      },
    );

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

describe('jest/expect-expect', () => {
  it('accepts a test whose assertion is made through expectRefused', () => {
    const result = lintFixture(`
      function expectRefused(): void {}
      describe('query refusals', () => {
        it('counts a shared assertion helper', () => {
          expectRefused();
        });
      });
    `);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('jest/expect-expect');
  });

  it('still rejects a test with no assertion', () => {
    const result = lintFixture(`
      describe('query refusals', () => {
        it('has no assertion', () => {});
      });
    `);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('expect-expect');
  });
});
