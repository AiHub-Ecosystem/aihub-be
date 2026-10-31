import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { driftAgainstMigrations } from '../../../scripts/checks/prisma-drift/prisma-drift.cjs';
import { adminDatabaseUrl } from './database';

const MIGRATIONS_DIR = join(__dirname, '../../../prisma/migrations');
const SCHEMA_PATH = join(__dirname, '../../../prisma/schema.prisma');

// Its own scratch name, so it never races `bun run check:prisma-drift`.
const SCRATCH_NAME = 'aihub_prisma_drift_spec';

describe('schema.prisma against the real migration history', () => {
  it('agrees with a database built from every migration', async () => {
    const drifted = await driftAgainstMigrations({
      adminUrl: adminDatabaseUrl(),
      migrationsDir: MIGRATIONS_DIR,
      schemaPath: SCHEMA_PATH,
      scratchName: SCRATCH_NAME,
    });

    expect(drifted).toEqual([]);
  }, 120_000);

  it('names a column that a migration adds and the schema does not declare', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aihub-drift-migrations-'));
    const migrationsWorkspace = join(workspace, 'migrations');
    try {
      cpSync(MIGRATIONS_DIR, migrationsWorkspace, { recursive: true });
      const probeDirectory = join(migrationsWorkspace, '9999_drift_probe');
      mkdirSync(probeDirectory);
      writeFileSync(
        join(probeDirectory, 'migration.sql'),
        'ALTER TABLE api_keys ADD COLUMN drift_probe text;\n',
      );

      const drifted = await driftAgainstMigrations({
        adminUrl: adminDatabaseUrl(),
        migrationsDir: migrationsWorkspace,
        schemaPath: SCHEMA_PATH,
        scratchName: SCRATCH_NAME,
      });

      expect(drifted.join('\n')).toContain('drift_probe');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
