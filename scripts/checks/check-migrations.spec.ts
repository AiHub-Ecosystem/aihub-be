import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const repositoryRoot = process.cwd();
const temporaryRoot = join(repositoryRoot, 'temp');
const squawkCli = join(
  repositoryRoot,
  'node_modules',
  'squawk-cli',
  'js',
  'bin',
  'squawk',
);

function removeTemporaryRootIfCreated(
  directory: string,
  createdByThisRun: boolean,
): void {
  if (!createdByThisRun) return;

  try {
    rmdirSync(directory);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')
    ) {
      return;
    }
    throw error;
  }
}

function runSquawk(migrations: Record<string, string>): {
  status: number | null;
  output: string;
} {
  const temporaryRootExisted = existsSync(temporaryRoot);
  mkdirSync(temporaryRoot, { recursive: true });
  const fixtureDirectory = mkdtempSync(join(temporaryRoot, 'squawk-'));

  try {
    const migrationFiles = Object.entries(migrations).map(([name, sql]) => {
      const migrationFile = join(fixtureDirectory, name);
      mkdirSync(dirname(migrationFile), { recursive: true });
      writeFileSync(migrationFile, sql);
      return relative(repositoryRoot, migrationFile).split(sep).join('/');
    });
    const result = spawnSync(
      process.execPath,
      [
        squawkCli,
        '--config',
        join(repositoryRoot, '.squawk.toml'),
        ...migrationFiles,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      },
    );

    if (result.error) throw result.error;
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
    removeTemporaryRootIfCreated(temporaryRoot, !temporaryRootExisted);
  }
}

describe('migration fixture cleanup', () => {
  it('leaves the temporary root when another fixture is still present', () => {
    const temporaryRootExisted = existsSync(temporaryRoot);
    mkdirSync(temporaryRoot, { recursive: true });
    const otherFixture = mkdtempSync(join(temporaryRoot, 'squawk-'));

    try {
      removeTemporaryRootIfCreated(temporaryRoot, !temporaryRootExisted);
      expect(existsSync(otherFixture)).toBe(true);
    } finally {
      rmSync(otherFixture, { recursive: true, force: true });
      removeTemporaryRootIfCreated(temporaryRoot, !temporaryRootExisted);
    }
  });
});

describe('Squawk migration policy', () => {
  it('rejects destructive and write-blocking migration statements in a new migration path', () => {
    const result = runSquawk({
      '0041_future_migration/migration.sql': [
        'ALTER TABLE organizations DROP COLUMN legacy_status;',
        'ALTER TABLE organizations RENAME COLUMN status TO current_status;',
        'ALTER TABLE organizations ADD COLUMN required_name TEXT NOT NULL;',
        "ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended'));",
      ].join('\n'),
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('ban-drop-column');
    expect(result.output).toContain('renaming-column');
    expect(result.output).toContain('adding-required-field');
    expect(result.output).toContain('constraint-missing-not-valid');
  });

  it('limits a rule-specific ignore to its statement and keeps other findings visible', () => {
    const result = runSquawk({
      '0041_narrow_ignore/migration.sql': [
        '-- squawk-ignore ban-drop-column -- reason: follows the reviewed expand-contract plan; #693',
        'ALTER TABLE organizations DROP COLUMN legacy_status;',
        "ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended'));",
      ].join('\n'),
    });

    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('ban-drop-column');
    expect(result.output).toContain('constraint-missing-not-valid');
  });

  it('atomically replaces a CHECK as NOT VALID and validates it in the following migration', () => {
    const result = runSquawk({
      '0041_add_check/migration.sql': [
        '-- squawk-ignore ban-drop-constraint -- reason: atomically replace the value-list CHECK; #693',
        'ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;',
        "ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended', 'pending')) NOT VALID;",
      ].join('\n'),
      '0042_validate_check/migration.sql':
        'ALTER TABLE organizations VALIDATE CONSTRAINT organizations_status_check;',
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('constraint-missing-not-valid');
  });

  it('requires concurrent creation for an existing table but allows a local new-table exception', () => {
    const result = runSquawk({
      '0041_indexes/migration.sql': [
        'CREATE TABLE new_table (id BIGINT, name TEXT);',
        '-- squawk-ignore require-concurrent-index-creation -- reason: table is created in this migration; #693',
        'CREATE INDEX new_table_name_idx ON new_table (name);',
        'CREATE INDEX organizations_name_idx ON organizations (name);',
      ].join('\n'),
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('organizations_name_idx');
    expect(result.output).not.toContain('new_table_name_idx');
  });

  it('keeps bigint guidance enabled unless one INTEGER statement has a narrow exception', () => {
    const result = runSquawk({
      '0041_integer_exception/migration.sql': [
        '-- squawk-ignore prefer-bigint-over-int -- reason: bounded status code; #693',
        'CREATE TABLE status_codes (value INTEGER);',
        'CREATE TABLE external_accounts (id INTEGER);',
        "ALTER TABLE organizations ADD CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended'));",
      ].join('\n'),
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('external_accounts');
    expect(result.output).not.toContain('status_codes');
    expect(result.output).toContain('constraint-missing-not-valid');
  });

  it('keeps only the 40 applied migration files on the explicit exclusion list', () => {
    const config = readFileSync(join(repositoryRoot, '.squawk.toml'), 'utf8');
    const excludedPaths =
      config.match(/^  "prisma\/migrations\/[^"*]+"[,]?$/gm) ?? [];
    const excludedRules = config
      .match(/excluded_rules = \[([\s\S]*?)\]/)?.[1]
      ?.match(/"[^"]+"/g);

    expect(excludedPaths).toHaveLength(40);
    expect(excludedRules).toEqual([
      '"require-lock-timeout"',
      '"require-statement-timeout"',
    ]);
    expect(config).toContain('pg_version = "16"');
    expect(config).toContain('assume_in_transaction = true');
    expect(config).toContain('lock_timeout=30s');
    expect(config).toContain('statement_timeout=300s');
    expect(config).not.toMatch(/prisma\/migrations\/[^"\r\n]*\*/);
    expect(config).not.toContain('0041_future_migration');
  });
});
