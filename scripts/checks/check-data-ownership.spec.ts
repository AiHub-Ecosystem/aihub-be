import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('data-ownership check', () => {
  const scratchDir = join(
    process.cwd(),
    'src',
    'modules',
    '__data_ownership_check__',
    'infrastructure',
  );
  const scratchFile = join(scratchDir, 'leak.ts');

  afterEach(() => {
    rmSync(join(process.cwd(), 'src', 'modules', '__data_ownership_check__'), {
      recursive: true,
      force: true,
    });
  });

  it('fails when a module queries a table it does not own without allowlist', () => {
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(scratchFile, 'const x = `SELECT * FROM user_accounts`;\n');

    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-data-ownership.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/user_accounts/);
  });

  it('passes on the real tree', () => {
    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-data-ownership.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    expect(result.status).toBe(0);
  });
});
