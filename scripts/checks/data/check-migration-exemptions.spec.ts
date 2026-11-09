import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(
  process.cwd(),
  'scripts',
  'checks',
  'data',
  'check-migration-exemptions.mjs',
);

function migrationPath(number: number, label = 'example'): string {
  return `prisma/migrations/${String(number).padStart(4, '0')}_${label}/migration.sql`;
}

/**
 * A throwaway repository tree holding only what the gate reads: `.squawk.toml`
 * and the migration directories it names. The gate takes its root from cwd, so
 * pointing it at this tree exercises the real parse and the real evaluation.
 */
function runCheck(
  excludedPaths: string[],
  existingMigrations: readonly number[],
): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'migration-exemptions-'));
  try {
    const list = excludedPaths.map((path) => `  "${path}",`).join('\n');
    writeFileSync(
      join(root, '.squawk.toml'),
      `pg_version = "16"\n\nexcluded_paths = [\n${list}\n]\n`,
    );
    for (const number of existingMigrations) {
      const dir = join(
        root,
        'prisma',
        'migrations',
        `${String(number).padStart(4, '0')}_example`,
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'migration.sql'), '-- fixture\n');
    }

    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-migration-exemptions', () => {
  it('passes a history-only exemption list whose migrations all exist', () => {
    const paths = [migrationPath(1), migrationPath(2), migrationPath(40)];

    const { status, output } = runCheck(paths, [1, 2, 40]);

    expect(status).toBe(0);
    expect(output).toContain('Migration exemption check passed');
    expect(output).toContain('3 historical exclusions');
  });

  it('fails a migration being written that was exempted instead of fixed', () => {
    const inFlight = migrationPath(63, 'speaking_grading_jobs');

    const { status, output } = runCheck([migrationPath(1), inFlight], [1, 63]);

    expect(status).toBe(1);
    expect(output).toContain('newer than the declared historical baseline');
    expect(output).toContain('0040');
    expect(output).toContain(inFlight);
  });

  it('fails every entry above the baseline, not only the first', () => {
    const beyond = [migrationPath(41), migrationPath(42), migrationPath(63)];

    const { status, output } = runCheck(beyond, [41, 42, 63]);

    expect(status).toBe(1);
    for (const path of beyond) expect(output).toContain(path);
  });

  it('accepts the baseline itself, so the boundary is not off by one', () => {
    const paths = [migrationPath(40)];

    const { status, output } = runCheck(paths, [40]);

    expect(status).toBe(0);
    expect(output).toContain('1 historical exclusions');
  });

  it('fails an exemption naming a migration that does not exist', () => {
    const missing = migrationPath(7);

    const { status, output } = runCheck([missing], []);

    expect(status).toBe(1);
    expect(output).toContain('does not exist');
    expect(output).toContain(missing);
  });

  it('fails an entry that is not a migration path at all', () => {
    const { status, output } = runCheck(
      ['prisma/migrations/0001_x/other.sql'],
      [1],
    );

    expect(status).toBe(1);
    expect(output).toContain('not prisma/migrations/');
  });

  it('reports a fully exempted repository as a failure, never a pass', () => {
    const all = Array.from({ length: 63 }, (_, index) =>
      migrationPath(index + 1),
    );
    const numbers = all.map((_, index) => index + 1);

    const { status, output } = runCheck(all, numbers);

    expect(status).toBe(1);
    expect(output).toContain('newer than the declared historical baseline');
  });

  it('passes an empty list, so a repository with no exemptions is not an error', () => {
    const { status } = runCheck([], []);

    expect(status).toBe(0);
  });
});
