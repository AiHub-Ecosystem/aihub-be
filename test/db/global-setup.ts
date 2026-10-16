import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

import { databaseUrlsForLane } from '../../scripts/checks/db-lane/database-targets';
import {
  DATABASE_LANE_POSTGRES_TIMEOUTS,
  TEST_DATABASE_NAME,
  adminDatabaseUrl,
  adminTarget,
  sandboxTestDatabaseUrl,
  testDatabaseUrl,
} from './database';
import { timeDatabasePhase } from './lane-timing';

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');

function databaseUrls(): string[] {
  return databaseUrlsForLane(
    TEST_DATABASE_NAME,
    testDatabaseUrl(),
    sandboxTestDatabaseUrl(),
  );
}

function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.slice(1);
}

async function dropTestDatabases(admin: Client): Promise<void> {
  for (const url of databaseUrls()) {
    await admin.query(
      `DROP DATABASE IF EXISTS ${databaseName(url)} WITH (FORCE)`,
    );
  }
}

/**
 * Rebuilds the lane's database from the repository's own migration files.
 *
 * They are applied here rather than by shelling out to `scripts/cli/migrate.mjs`:
 * that script loads the runtime connection environment when `dist/` is built,
 * which overwrites `DATABASE_URL` and would point this lane at whatever
 * database the developer's runtime secrets name. Reading the same files keeps
 * the schema honest while making it impossible for the lane to reach past the
 * database it created.
 */
export default async function globalSetup(): Promise<void> {
  const admin = new Client({
    connectionString: adminDatabaseUrl(),
    ...DATABASE_LANE_POSTGRES_TIMEOUTS,
  });

  try {
    await timeDatabasePhase('PostgreSQL admin connection', async () => {
      try {
        await admin.connect();
      } catch {
        throw new Error(
          `The database lane needs PostgreSQL at ${adminTarget()}.`,
        );
      }
    });
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw error;
  }

  try {
    await timeDatabasePhase('test database creation', async () => {
      for (const url of databaseUrls()) {
        const name = databaseName(url);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${name}`);
      }
    });

    const migrations = await timeDatabasePhase(
      'migration file discovery',
      async () => {
        const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      },
    );

    for (const url of databaseUrls()) {
      const name = databaseName(url);
      const target = new Client({
        connectionString: url,
        ...DATABASE_LANE_POSTGRES_TIMEOUTS,
      });

      await timeDatabasePhase(
        `migration replay (${name}, ${migrations.length} files)`,
        async () => {
          try {
            await target.connect();
            for (const directory of migrations) {
              const sql = await readFile(
                join(MIGRATIONS_DIR, directory, 'migration.sql'),
                'utf8',
              );
              try {
                await target.query(sql);
              } catch {
                throw new Error(`Migration failed: ${directory}`);
              }
            }
          } finally {
            await target.end().catch(() => undefined);
          }
        },
      );
    }
  } catch (error) {
    try {
      await timeDatabasePhase('test database cleanup after setup failure', () =>
        dropTestDatabases(admin),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Database lane setup failed and test database cleanup also failed.',
      );
    }
    throw error;
  } finally {
    await admin.end();
  }
}
