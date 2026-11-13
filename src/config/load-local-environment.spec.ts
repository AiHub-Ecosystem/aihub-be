import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLocalEnvironment } from './load-local-environment';

describe('loadLocalEnvironment', () => {
  let directory: string;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aihub-local-env-'));
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await rm(directory, { force: true, recursive: true });
  });

  async function writeEnvFile(): Promise<void> {
    await writeFile(
      join(directory, '.env'),
      'AIHUB_LOCAL_ENV_PROBE=1\n',
      'utf8',
    );
  }

  it('loads the file in development and test modes', async () => {
    await writeEnvFile();

    delete process.env['AIHUB_LOCAL_ENV_PROBE'];
    loadLocalEnvironment('development', directory);
    expect(process.env['AIHUB_LOCAL_ENV_PROBE']).toBe('1');
    expect(errorSpy).not.toHaveBeenCalled();

    delete process.env['AIHUB_LOCAL_ENV_PROBE'];
    loadLocalEnvironment('test', directory);
    expect(process.env['AIHUB_LOCAL_ENV_PROBE']).toBe('1');
    delete process.env['AIHUB_LOCAL_ENV_PROBE'];
  });

  it('loads the file when the mode is unset, preserving the local-run behavior', async () => {
    await writeEnvFile();

    loadLocalEnvironment(undefined, directory);

    expect(process.env['AIHUB_LOCAL_ENV_PROBE']).toBe('1');
    expect(errorSpy).not.toHaveBeenCalled();
    delete process.env['AIHUB_LOCAL_ENV_PROBE'];
  });

  it('refuses the file in production and staging modes instead of consuming it', async () => {
    await writeEnvFile();

    for (const mode of ['production', 'staging']) {
      errorSpy.mockClear();

      loadLocalEnvironment(mode, directory);

      expect(process.env['AIHUB_LOCAL_ENV_PROBE']).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [loggedLine] = (errorSpy.mock.calls as unknown[][])[0] ?? [];
      expect(typeof loggedLine).toBe('string');
      expect(JSON.parse(loggedLine as string)).toMatchObject({
        level: 'error',
        event: 'local_env_file_refused',
        mode,
        env_file: join(directory, '.env'),
      });
    }
  });

  it('does nothing when the directory carries no .env file', () => {
    loadLocalEnvironment('development', directory);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('names a malformed line instead of importing it into the process', async () => {
    await writeFile(join(directory, '.env'), 'A=1\nBROKEN LINE\n', 'utf8');

    expect(() => loadLocalEnvironment('development', directory)).toThrow(
      '.env',
    );
    expect(process.env['A']).toBeUndefined();
  });

  it('preserves values already set by the operator', async () => {
    await writeFile(
      join(directory, '.env'),
      'AIHUB_LOCAL_ENV_PROBE=file\n',
      'utf8',
    );
    process.env['AIHUB_LOCAL_ENV_PROBE'] = 'operator';

    loadLocalEnvironment('development', directory);

    expect(process.env['AIHUB_LOCAL_ENV_PROBE']).toBe('operator');
    delete process.env['AIHUB_LOCAL_ENV_PROBE'];
  });
});
