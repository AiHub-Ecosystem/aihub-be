import { runGuardedTransaction } from '@/modules/persistence/infrastructure/prisma-raw';
import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { Prisma, PrismaClient } from '@prisma-client/client';

import { createTestPool } from '../../shared/database';
import { eventually, postgresThroughProxy, timed } from './fault-targets';
import type { TcpFaultProxy } from './tcp-fault-proxy';

// A transaction whose cleanup cannot be confirmed must not hand its open
// transaction to the next borrower (#1285). The factory, pool, and timeouts are
// the production ones; only the link is faulted. Every check of the server
// side is made from a separate connection, because an idle pool count or a
// successful `SELECT 1` does not show that PostgreSQL left the transaction.

const PROBE = 'transaction_cleanup_probe';
// A synthetic key in the Sandbox budget lock family.
const LOCK_SQL = 'pg_advisory_xact_lock(182, 24321)';

// Two statements can each wait out query_timeout (5 s): the stalled one and
// the rollback queued behind it.
jest.setTimeout(40_000);

type Work = (transaction: Prisma.TransactionClient) => Promise<void>;
type Run = (prisma: PrismaClient, work: Work) => Promise<void>;

const RUNS: readonly (readonly [string, Run])[] = [
  ['direct $transaction', (prisma, work) => prisma.$transaction(work)],
  [
    'runGuardedTransaction',
    (prisma, work) =>
      prisma.$transaction((transaction) =>
        runGuardedTransaction(transaction, work, {
          expired: () => new Error('transaction handle expired'),
        }),
      ),
  ],
];

let pool: ReturnType<typeof createTestPool>;
let proxy: TcpFaultProxy;
let proxiedUrl: string;

beforeAll(async () => {
  pool = createTestPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${PROBE} (id integer PRIMARY KEY)`,
  );
  const target = await postgresThroughProxy();
  proxy = target.proxy;
  proxiedUrl = target.url;
});

beforeEach(async () => {
  await proxy.setMode('normal');
  await pool.query(`TRUNCATE ${PROBE}`);
});

afterAll(async () => {
  await proxy.close();
  await pool.query(`DROP TABLE IF EXISTS ${PROBE}`);
  await pool.end();
});

async function committedRows(): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM ${PROBE} ORDER BY id`,
  );
  return rows.map((row) => row.id);
}

async function backend(
  pid: number,
): Promise<{ state: string; wait_event: string | null } | undefined> {
  const { rows } = await pool.query<{
    state: string;
    wait_event: string | null;
  }>('SELECT state, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
  return rows[0];
}

/** Whether an independent session can take the lock the transaction held. */
async function lockIsFree(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ free: boolean }>(
      'SELECT pg_try_advisory_xact_lock(182, 24321) AS free',
    );
    return rows[0]?.free === true;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Takes the lock and returns the transaction's backend. */
async function lockedBackend(
  transaction: Prisma.TransactionClient,
): Promise<number> {
  const [row] = await transaction.$queryRawUnsafe<{ pid: number }[]>(
    `SELECT pg_backend_pid() AS pid FROM (SELECT ${LOCK_SQL}) AS locked`,
  );
  if (row === undefined) throw new Error('no backend pid');
  return row.pid;
}

/** Later work on the same pool commits only its own rows. */
async function expectCleanReuse(prisma: PrismaClient, run: Run) {
  await prisma.$executeRawUnsafe(`INSERT INTO ${PROBE} VALUES (2)`);
  expect(await committedRows()).toEqual([2]);
  await run(prisma, async (transaction) => {
    await transaction.$executeRawUnsafe(`INSERT INTO ${PROBE} VALUES (3)`);
  });
  expect(await committedRows()).toEqual([2, 3]);
}

/** The backend is gone, its lock released, and none of its rows committed. */
async function expectEvicted(pid: number) {
  // A backend notices the closed socket once its running statement ends.
  await eventually(async () => (await backend(pid)) === undefined, 6_000);
  expect(await lockIsFree()).toBe(true);
  expect(await committedRows()).toEqual([]);
}

describe.each(RUNS)('a transaction through %s', (_name, run) => {
  it('keeps the connection after a confirmed rollback (control)', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    try {
      let pid = 0;
      await expect(
        run(holder.prisma, async (transaction) => {
          pid = await lockedBackend(transaction);
          await transaction.$executeRawUnsafe(
            `INSERT INTO ${PROBE} VALUES (1)`,
          );
          throw new Error('callback failed');
        }),
      ).rejects.toThrow('callback failed');

      expect(holder.pool.totalCount).toBe(1);
      expect(await backend(pid)).toMatchObject({ state: 'idle' });
      expect(await lockIsFree()).toBe(true);
      expect(await committedRows()).toEqual([]);
      await expectCleanReuse(holder.prisma, run);
    } finally {
      await holder.close();
    }
  });

  it('keeps the connection after a recoverable query error (control)', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    try {
      let pid = 0;
      await expect(
        run(holder.prisma, async (transaction) => {
          pid = await lockedBackend(transaction);
          await transaction.$executeRawUnsafe(
            `INSERT INTO ${PROBE} VALUES (1)`,
          );
          await transaction.$executeRawUnsafe(
            `INSERT INTO ${PROBE} VALUES (1)`,
          );
        }),
      ).rejects.toThrow(/unique|duplicate/i);

      expect(holder.pool.totalCount).toBe(1);
      expect(await backend(pid)).toMatchObject({ state: 'idle' });
      expect(await lockIsFree()).toBe(true);
      expect(await committedRows()).toEqual([]);
      await expectCleanReuse(holder.prisma, run);
    } finally {
      await holder.close();
    }
  });

  it('evicts the connection when the link stalls after a statement reaches PostgreSQL', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    try {
      let pid = 0;
      const running = timed(() =>
        run(holder.prisma, async (transaction) => {
          pid = await lockedBackend(transaction);
          await transaction.$executeRawUnsafe(
            `INSERT INTO ${PROBE} SELECT 1 FROM pg_sleep(3)`,
          );
        }),
      );
      await eventually(
        async () => pid !== 0 && (await backend(pid))?.wait_event === 'PgSleep',
      );
      await proxy.setMode('hang');

      const { result } = await running;

      expect(result.status).toBe('rejected');
      // Evicted before the caller saw the error: nothing can borrow it again.
      expect(holder.pool.totalCount).toBe(0);
      await expectEvicted(pid);
      await proxy.setMode('normal');
      await expectCleanReuse(holder.prisma, run);
    } finally {
      await proxy.setMode('normal');
      await holder.close();
    }
  });

  it('evicts the connection when its rollback times out', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    try {
      let pid = 0;
      const { result } = await timed(() =>
        run(holder.prisma, async (transaction) => {
          pid = await lockedBackend(transaction);
          await transaction.$executeRawUnsafe(
            `INSERT INTO ${PROBE} VALUES (1)`,
          );
          await proxy.setMode('hang');
          throw new Error('callback failed');
        }),
      );

      expect(result.status).toBe('rejected');
      expect(holder.pool.totalCount).toBe(0);
      await expectEvicted(pid);
      await proxy.setMode('normal');
      await expectCleanReuse(holder.prisma, run);
    } finally {
      await proxy.setMode('normal');
      await holder.close();
    }
  });

  it('commits nothing when the connection drops mid-transaction', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    try {
      let pid = 0;
      const running = timed(() =>
        run(holder.prisma, async (transaction) => {
          pid = await lockedBackend(transaction);
          await transaction.$executeRawUnsafe(
            `INSERT INTO ${PROBE} SELECT 1 FROM pg_sleep(3)`,
          );
        }),
      );
      await eventually(
        async () => pid !== 0 && (await backend(pid))?.wait_event === 'PgSleep',
      );
      await proxy.setMode('refuse');

      const { result } = await running;

      expect(result.status).toBe('rejected');
      expect(holder.pool.totalCount).toBe(0);
      await expectEvicted(pid);
      await proxy.setMode('normal');
      await expectCleanReuse(holder.prisma, run);
    } finally {
      await proxy.setMode('normal');
      await holder.close();
    }
  });
});
