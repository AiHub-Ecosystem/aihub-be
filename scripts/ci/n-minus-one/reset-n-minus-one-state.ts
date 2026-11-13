import Redis from 'ioredis';
import { Pool } from 'pg';

import { DATABASE_URL } from './n-minus-one-runtime';

async function reset(): Promise<void> {
  const database = new Pool({ connectionString: DATABASE_URL });
  const redis = new Redis('redis://127.0.0.1:6379/0', {
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  try {
    await database.query(
      "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'aihub_email_delivery'",
    );
    await database.query('DROP PUBLICATION IF EXISTS aihub_email_delivery');
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await redis.flushall();
    await database.query('SELECT 1');
    if ((await redis.ping()) !== 'PONG') {
      throw new Error('Redis fixture reset did not complete');
    }
  } finally {
    await database.end();
    redis.disconnect();
  }
}

reset().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'N-1 reset failed');
  process.exitCode = 1;
});
