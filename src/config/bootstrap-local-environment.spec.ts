import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `process.loadEnvFile` writes to the real `process.env`, so a spec whose import
 * loads a developer's `.env` hands those values to every later suite in the same
 * worker (#1632). Each test below is the first import of its module in this
 * file. It runs with a `.env` in the working directory and the loader spied, so
 * the result does not depend on a `.env` existing in the repository.
 */
async function loadsWhileImporting(
  load: () => Promise<unknown>,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), 'aihub-bootstrap-env-'));
  const original = process.cwd();
  const loadSpy = jest
    .spyOn(process, 'loadEnvFile')
    .mockImplementation(() => {});
  try {
    await writeFile(join(directory, '.env'), 'AIHUB_PROBE=1\n', 'utf8');
    process.chdir(directory);
    await load();
    return loadSpy.mock.calls.length;
  } finally {
    process.chdir(original);
    loadSpy.mockRestore();
    await rm(directory, { force: true, recursive: true });
  }
}

describe('local environment loading is an explicit bootstrap step (#1632)', () => {
  it('does not load a .env file when the loader module is imported', async () => {
    expect(
      await loadsWhileImporting(() => import('./load-local-environment')),
    ).toBe(0);
  });

  it('loads the working directory .env once when the bootstrap module is imported', async () => {
    expect(
      await loadsWhileImporting(() => import('./bootstrap-local-environment')),
    ).toBe(1);
  });
});
