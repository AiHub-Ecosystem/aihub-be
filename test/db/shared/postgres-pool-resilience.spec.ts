import { Client, type Pool } from 'pg';

import { getMetrics } from '@/common/observability/metrics';
import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { testDatabaseUrl } from './database';

const POOL_NAME = 'integration-test';
const SQLSTATE_CLASS = '57';

let pool: Pool;
let operator: Client;

beforeAll(async () => {
  const connectionString = testDatabaseUrl();
  pool = createPostgresPool(POOL_NAME, {
    connectionString,
    max: 2,
    connectionTimeoutMillis: 1_000,
  });
  operator = new Client({ connectionString });
  await operator.connect();
});

afterAll(async () => {
  await Promise.all([pool.end(), operator.end()]);
});

function poolErrorCount(
  metrics: string,
  sqlstateClasses: readonly string[] = [SQLSTATE_CLASS],
): number {
  const lines = metrics
    .split('\n')
    .filter((candidate) =>
      candidate.startsWith(
        `aihub_postgres_pool_errors_total{pool="${POOL_NAME}",`,
      ),
    );
  return lines
    .filter((line) =>
      sqlstateClasses.some((sqlstateClass) =>
        line.includes(`sqlstate_class="${sqlstateClass}"`),
      ),
    )
    .reduce((total, line) => total + Number(line.split(' ').at(-1)), 0);
}

async function waitForPoolErrorCount(
  previousCount: number,
  sqlstateClasses: readonly string[] = [SQLSTATE_CLASS],
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = poolErrorCount(await getMetrics(), sqlstateClasses);
    if (count > previousCount) {
      return count;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('PostgreSQL pool error was not recorded within 5 seconds');
}

async function terminateBackend(pid: number): Promise<void> {
  const result = await operator.query<{ terminated: boolean }>(
    'SELECT pg_terminate_backend($1) AS terminated',
    [pid],
  );
  expect(result.rows[0]?.terminated).toBe(true);
}

describe('PostgreSQL pool connection failures', () => {
  it('records an idle connection failure and reconnects without exiting', async () => {
    const processExitCode = process.exitCode;
    const previousCount = poolErrorCount(await getMetrics());
    const pid = Number(
      (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]?.pid,
    );

    await terminateBackend(pid);

    expect(await waitForPoolErrorCount(previousCount)).toBe(previousCount + 1);
    expect(process.exitCode).toBe(processExitCode);
    await expect(pool.query('SELECT 1')).resolves.toMatchObject({
      rows: [{ '?column?': 1 }],
    });
  });

  it('fails a transaction on a dropped checked-out connection and keeps the process alive', async () => {
    const processExitCode = process.exitCode;
    const errorClasses = [SQLSTATE_CLASS, 'unknown'];
    const previousCount = poolErrorCount(await getMetrics(), errorClasses);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const pid = Number(
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid,
      );
      await terminateBackend(pid);
      await expect(client.query('SELECT 1')).rejects.toBeDefined();
    } finally {
      client.release();
    }

    expect(await waitForPoolErrorCount(previousCount, errorClasses)).toBe(
      previousCount + 1,
    );
    expect(process.exitCode).toBe(processExitCode);
    await expect(pool.query('SELECT 1')).resolves.toMatchObject({
      rows: [{ '?column?': 1 }],
    });
  });
});
