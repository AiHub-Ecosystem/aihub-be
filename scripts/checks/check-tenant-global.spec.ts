import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('tenant-global check', () => {
  const scratchDir = join(
    process.cwd(),
    'src',
    'modules',
    '__tenant_global_check__',
  );
  const scratchFile = join(scratchDir, 'application', 'leak.ts');

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('fails when a module declares a top-level tenant/org variable', () => {
    mkdirSync(join(scratchDir, 'application'), { recursive: true });
    writeFileSync(
      scratchFile,
      'let organizationId = "org_1";\nexport const x = 1;\n',
    );

    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-tenant-global.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(
      /module-level mutable tenant state/,
    );
  });

  it('passes on the real tree', () => {
    const result = spawnSync(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['scripts/checks/check-tenant-global.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        shell: process.platform === 'win32',
      },
    );
    expect(result.status).toBe(0);
  });
});
