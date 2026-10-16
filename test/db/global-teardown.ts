import { Client } from 'pg';

import { databaseUrlsForLane } from '../../scripts/checks/db-lane/database-targets';
import {
  DATABASE_LANE_POSTGRES_TIMEOUTS,
  TEST_DATABASE_NAME,
  adminDatabaseUrl,
  sandboxTestDatabaseUrl,
  testDatabaseUrl,
} from './database';
import { timeDatabasePhase } from './lane-timing';

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

export default async function globalTeardown(): Promise<void> {
  const admin = new Client({
    connectionString: adminDatabaseUrl(),
    ...DATABASE_LANE_POSTGRES_TIMEOUTS,
  });

  try {
    await timeDatabasePhase('PostgreSQL admin connection', () =>
      admin.connect(),
    );
    for (const url of databaseUrls()) {
      const name = databaseName(url);
      await timeDatabasePhase(`test database cleanup (${name})`, () =>
        admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
      );
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}
