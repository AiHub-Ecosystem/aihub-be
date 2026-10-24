import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLocalEnvironment } from './load-local-environment';

describe('loadLocalEnvironment', () => {
  let directory: string;
  let errorSpy: jest.SpyInstance;
  let loadSpy: jest.SpyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aihub-local-env-'));
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    loadSpy = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    loadSpy.mockRestore();
    await rm(directory, { force: true, recursive: true });
  });

  async function writeEnvFile(): Promise<void> {
    await writeFile(join(directory, '.env'), 'AIHUB_PROBE=1\n', 'utf8');
  }

  it('loads the file in development and test modes', async () => {
    await writeEnvFile();

    loadLocalEnvironment('development', directory);
    expect(loadSpy).toHaveBeenCalledWith(join(directory, '.env'));
    expect(errorSpy).not.toHaveBeenCalled();

    loadSpy.mockClear();
    loadLocalEnvironment('test', directory);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('loads the file when the mode is unset, preserving the local-run behavior', async () => {
    await writeEnvFile();

    loadLocalEnvironment(undefined, directory);

    expect(loadSpy).toHaveBeenCalledWith(join(directory, '.env'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('refuses the file in production and staging modes instead of consuming it', async () => {
    await writeEnvFile();

    for (const mode of ['production', 'staging']) {
      errorSpy.mockClear();
      loadSpy.mockClear();

      loadLocalEnvironment(mode, directory);

      expect(loadSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain('Refusing to load');
      expect(errorSpy.mock.calls[0]?.[0]).toContain(mode);
    }
  });

  it('does nothing when the directory carries no .env file', () => {
    loadLocalEnvironment('development', directory);

    expect(loadSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
