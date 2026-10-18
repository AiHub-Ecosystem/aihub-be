import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'check-tenant-global.mjs',
);

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('tenant-global check', () => {
  // The failing case builds its own tree: a scratch file inside the real `src/`
  // races the other checks that scan it from parallel Jest workers.
  it('fails when a module declares a top-level tenant/org variable', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-tenant-global-'));
    try {
      const moduleDir = join(
        fixtureRoot,
        'src',
        'modules',
        'leaky',
        'application',
      );
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'leak.ts'),
        'let organizationId = "org_1";\nexport const x = 1;\n',
      );

      const result = runCheck(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(
        /module-level mutable tenant state/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('passes on the real tree', () => {
    expect(runCheck(process.cwd()).status).toBe(0);
  });
});
