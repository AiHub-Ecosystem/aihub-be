import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';

import { AppModule } from '@/app.module';
import {
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import { ulid } from 'ulid';

import { createTestPool, testDatabaseUrl } from '../shared/database';

const PGBOUNCER_URL = process.env.AIHUB_PGBOUNCER_TEST_URL?.trim();
const HTTP_PROBE_SQL = 'aihub_pgbouncer_http_probe';
const BACKEND_HOLDER_SQL = 'aihub_pgbouncer_backend_wait_probe';
const POOLER_APPLICATION_NAME = 'aihub_pgbouncer_http_test';
const SLEEP_SECONDS = 1.25;

@Controller('__test/pgbouncer')
class PgBouncerProbeController {
  constructor(
    @Inject(RUNTIME_PRISMA_CLIENT)
    private readonly runtime: PrismaClientHolder,
  ) {}

  @Get('prepared/:value')
  async prepared(@Param('value') value: string): Promise<{
    value: string;
    prepared: boolean;
    timeouts: { statement: string; lock: string; idleTransaction: string };
  }> {
    return this.runtime.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<{ value: string }[]>`
        SELECT ${value}::text AS value
      `;
      const statements = await transaction.$queryRaw<{ statement: string }[]>`
        SELECT statement
        FROM pg_prepared_statements
        WHERE statement LIKE '%SELECT $1::text AS value%'
      `;
      const [timeouts] = await transaction.$queryRaw<
        { statement: string; lock: string; idleTransaction: string }[]
      >`
        SELECT current_setting('statement_timeout') AS statement,
               current_setting('lock_timeout') AS lock,
               current_setting('idle_in_transaction_session_timeout') AS "idleTransaction"
      `;
      return {
        value: rows[0]?.value ?? '',
        prepared: statements.length > 0,
        timeouts: timeouts!,
      };
    });
  }

  @Post('write/:id')
  async write(@Param('id') id: string): Promise<{ saved: true }> {
    await this.runtime.prisma.$executeRaw`
      INSERT INTO aihub_pgbouncer_http_probe (id) VALUES (${id})
    `;
    return { saved: true };
  }

  @Post('sleep-and-write/:id')
  async sleepAndWrite(@Param('id') id: string): Promise<{ saved: true }> {
    return this.runtime.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT true AS waited
        FROM pg_sleep(${SLEEP_SECONDS}) /* aihub_pgbouncer_http_probe */
      `;
      await transaction.$executeRaw`
        INSERT INTO aihub_pgbouncer_http_probe (id) VALUES (${id})
      `;
      return { saved: true };
    });
  }
}

const describePgBouncer =
  PGBOUNCER_URL === undefined ? describe.skip : describe;

describePgBouncer('PgBouncer transaction pooling over HTTP', () => {
  let app: NestFastifyApplication;
  let adminPool: Pool;
  let holderPool: Pool;
  let runtimePool: PrismaClientHolder['pool'];
  let restoreEnvironment: () => void;

  beforeAll(async () => {
    if (PGBOUNCER_URL === undefined) return;
    const poolerUrl = withApplicationName(PGBOUNCER_URL);
    restoreEnvironment = configurePoolerRuntime(poolerUrl);
    adminPool = createTestPool();
    holderPool = new Pool({
      connectionString: poolerUrl,
      max: 2,
      connectionTimeoutMillis: 1_000,
      query_timeout: 3_000,
    });
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS aihub_pgbouncer_http_probe (
        id text PRIMARY KEY
      )
    `);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [PgBouncerProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    runtimePool = app.get<PrismaClientHolder>(RUNTIME_PRISMA_CLIENT).pool;
  });

  beforeEach(async () => {
    if (PGBOUNCER_URL === undefined) return;
    await adminPool.query('TRUNCATE aihub_pgbouncer_http_probe');
  });

  afterAll(async () => {
    if (PGBOUNCER_URL === undefined) return;
    await adminPool.query('DROP TABLE IF EXISTS aihub_pgbouncer_http_probe');
    await app.close();
    await Promise.all([holderPool.end(), adminPool.end()]);
    restoreEnvironment();
  });

  it('uses prepared parameters and rejects app-pool waiters within one second', async () => {
    expect(runtimePool.options.max).toBe(1);
    const preparedOne = await app.inject({
      method: 'GET',
      url: '/__test/pgbouncer/prepared/first',
    });
    const preparedTwo = await app.inject({
      method: 'GET',
      url: '/__test/pgbouncer/prepared/second',
    });
    expect(preparedOne.json()).toEqual({
      value: 'first',
      prepared: true,
      timeouts: { statement: '4s', lock: '1s', idleTransaction: '10s' },
    });
    expect(preparedTwo.json()).toEqual({
      value: 'second',
      prepared: true,
      timeouts: { statement: '4s', lock: '1s', idleTransaction: '10s' },
    });

    const holderId = ulid();
    const waiterId = ulid();
    const holder = app.inject({
      method: 'POST',
      url: `/__test/pgbouncer/sleep-and-write/${holderId}`,
    });
    await waitForActiveQuery(adminPool, HTTP_PROBE_SQL, 1);

    const startedAt = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: `/__test/pgbouncer/write/${waiterId}`,
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expectUnavailable(response);
    expect((await holder).json()).toEqual({ saved: true });

    expect(await storedIds(adminPool)).toEqual([holderId]);
    await expectNoActiveQuery(adminPool, HTTP_PROBE_SQL);
    await expectNoOrphanBackends(adminPool);
    const recovered = await app.inject({
      method: 'GET',
      url: '/__test/pgbouncer/prepared/recovered',
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      value: 'recovered',
      prepared: true,
    });
  });

  it('returns retryable unavailability while PgBouncer has no backend slots', async () => {
    const holders = [1, 2].map(() =>
      holderPool.query(
        `SELECT pg_sleep(${SLEEP_SECONDS}) /* ${BACKEND_HOLDER_SQL} */`,
      ),
    );
    await waitForActiveQuery(adminPool, BACKEND_HOLDER_SQL, 2);

    const waiterId = ulid();
    const startedAt = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: `/__test/pgbouncer/write/${waiterId}`,
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expectUnavailable(response);

    await Promise.all(holders);
    expect(await storedIds(adminPool)).toEqual([]);
    await expectNoActiveQuery(adminPool, BACKEND_HOLDER_SQL);
    await expectNoOrphanBackends(adminPool);
    const recovered = await app.inject({
      method: 'GET',
      url: '/__test/pgbouncer/prepared/backend-recovered',
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      value: 'backend-recovered',
      prepared: true,
    });
  });

  it('keeps combined app-checkout and PgBouncer wait within one second', async () => {
    const holders = [1, 2].map(() =>
      holderPool.query(
        `SELECT pg_sleep(${SLEEP_SECONDS}) /* ${BACKEND_HOLDER_SQL} */`,
      ),
    );
    await waitForActiveQuery(adminPool, BACKEND_HOLDER_SQL, 2);

    const first = app.inject({
      method: 'POST',
      url: `/__test/pgbouncer/write/${ulid()}`,
    });
    await waitForApplicationPoolBorrow(runtimePool);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startedAt = performance.now();
    const second = await app.inject({
      method: 'POST',
      url: `/__test/pgbouncer/write/${ulid()}`,
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expectUnavailable(second);
    expectUnavailable(await first);

    await Promise.all(holders);
    expect(await storedIds(adminPool)).toEqual([]);
    await expectNoActiveQuery(adminPool, BACKEND_HOLDER_SQL);
    await expectNoOrphanBackends(adminPool);
  });
});

function configurePoolerRuntime(poolerUrl: string): () => void {
  const directUrl = testDatabaseUrl();
  const variables: Record<string, string> = {
    AIHUB_DATABASE_POOLER_ENABLED: 'true',
    AIHUB_POSTGRES_POOL_MAX_RUNTIME: '1',
    AIHUB_POSTGRES_POOL_MAX_CONTROL_PLANE: '1',
    AIHUB_POSTGRES_POOL_MAX_CONTROL_PLANE_READ: '1',
    AIHUB_POSTGRES_POOL_MAX_EMAIL_DAILY_BUDGET: '1',
    DATABASE_URL: poolerUrl,
    CONTROL_PLANE_DATABASE_URL: directUrl,
    CONTROL_PLANE_READ_DATABASE_URL: directUrl,
    AIHUB_EMAIL_DAILY_BUDGET_DATABASE_URL: directUrl,
  };
  const previous = new Map(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(variables)) {
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function withApplicationName(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', POOLER_APPLICATION_NAME);
  return url.toString();
}

async function waitForApplicationPoolBorrow(
  pool: PrismaClientHolder['pool'],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pool.totalCount === 1 && pool.idleCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the first HTTP request did not acquire its app pool client');
}

async function waitForActiveQuery(
  pool: Pool,
  marker: string,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND state = 'active'
         AND query LIKE $1`,
      [`%${marker}%`],
    );
    if ((result.rows[0]?.count ?? 0) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `PostgreSQL did not observe ${expectedCount} active probe queries`,
  );
}

async function expectNoActiveQuery(pool: Pool, marker: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND state = 'active'
         AND query LIKE $1`,
      [`%${marker}%`],
    );
    if (result.rows[0]?.count === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('a PgBouncer probe query remained active after completion');
}

async function storedIds(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM aihub_pgbouncer_http_probe ORDER BY id',
  );
  return result.rows.map(({ id }) => id);
}

async function expectNoOrphanBackends(pool: Pool): Promise<void> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND application_name = $1`,
    [POOLER_APPLICATION_NAME],
  );
  expect(result.rows[0]?.count ?? 0).toBeLessThanOrEqual(2);
}

function expectUnavailable(response: {
  readonly statusCode: number;
  json<T>(): T;
}): void {
  expect(response.statusCode).toBe(503);
  expect(
    response.json<{ error: { code: string; retryable: boolean } }>().error,
  ).toMatchObject({
    code: 'DATABASE_UNAVAILABLE',
    retryable: true,
  });
}
