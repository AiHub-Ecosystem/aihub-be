import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'data',
  'check-data-ownership.mjs',
);

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function runCheckInFixture(schema: string, files: Record<string, string>) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aihub-data-ownership-'));
  try {
    mkdirSync(join(fixtureRoot, 'prisma'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'prisma', 'schema.prisma'), schema);
    mkdirSync(join(fixtureRoot, 'src', 'modules'), { recursive: true });
    for (const match of realSchema.matchAll(/@owner\s+(\w+)/g)) {
      const owner = match[1];
      if (owner === undefined) continue;
      mkdirSync(join(fixtureRoot, 'src', 'modules', owner), {
        recursive: true,
      });
    }
    for (const [rel, content] of Object.entries(files)) {
      const file = join(fixtureRoot, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return runCheck(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const realSchema = readFileSync(
  join(process.cwd(), 'prisma', 'schema.prisma'),
  'utf8',
);
const allowlistedLockPath =
  'src/modules/identity/organizations/infrastructure/postgres-organization-creation.repository.ts';

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

  it('fails when a Prisma model has no owner annotation', () => {
    const result = runCheckInFixture('model Ghost {\n  id Int @id\n}\n', {});

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Ghost/);
  });

  it('fails when a model names a non-module owner', () => {
    const result = runCheckInFixture(
      '/// @owner notamodule\nmodel Ghost {\n  id Int @id\n}\n',
      {},
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Ghost/);
    expect(result.stderr + result.stdout).toMatch(/notamodule/);
  });

  it.each([
    'INSERT INTO user_accounts (id) VALUES (1)',
    'UPDATE user_accounts SET id = 1',
    'DELETE FROM user_accounts WHERE id = 1',
  ])('rejects an allowlisted cross-owner write: %s', (statement) => {
    const result = runCheckInFixture(realSchema, {
      [allowlistedLockPath]: `const x = \`${statement}\`;\n`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/user_accounts/);
  });

  it('keeps allowlisted lock-only reads valid', () => {
    const result = runCheckInFixture(realSchema, {
      [allowlistedLockPath]:
        'const x = `SELECT * FROM user_accounts WHERE id = 1 FOR UPDATE`;\n',
    });

    expect(result.status).toBe(0);
  });

  it('passes on the real tree', () => {
    expect(runCheck(process.cwd()).status).toBe(0);
  }, 15_000);
});
