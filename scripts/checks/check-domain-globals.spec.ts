import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('domain-globals check', () => {
  const scratchDir = join(
    process.cwd(),
    'src',
    'modules',
    '__domain_globals_check__',
    'domain',
  );
  const scratchFile = join(scratchDir, 'leak.ts');

  afterEach(() => {
    rmSync(join(process.cwd(), 'src', 'modules', '__domain_globals_check__'), {
      recursive: true,
      force: true,
    });
  });

  it('fails when domain code uses a bare global', () => {
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(scratchFile, 'export const x = Date.now();\n');

    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-domain-globals.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/bare global/);
  });

  it('passes on the real tree', () => {
    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-domain-globals.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    expect(result.status).toBe(0);
  });
});
