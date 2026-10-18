import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'check-data-ownership.mjs',
);

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

describe('data-ownership check', () => {
  // The failing case builds its own tree: a scratch file inside the real `src/`
  // races the other checks that scan it from parallel Jest workers.
  it('fails when a module queries a table it does not own without allowlist', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-data-ownership-'));
    try {
      mkdirSync(join(fixtureRoot, 'prisma'));
      copyFileSync(
        join(process.cwd(), 'prisma', 'schema.prisma'),
        join(fixtureRoot, 'prisma', 'schema.prisma'),
      );
      const moduleDir = join(
        fixtureRoot,
        'src',
        'modules',
        'leaky',
        'infrastructure',
      );
      mkdirSync(moduleDir, { recursive: true });
      writeFileSync(
        join(moduleDir, 'leak.ts'),
        'const x = `SELECT * FROM user_accounts`;\n',
      );

      const result = runCheck(fixtureRoot);

      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/user_accounts/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('passes on the real tree', () => {
    expect(runCheck(process.cwd()).status).toBe(0);
  });
});
