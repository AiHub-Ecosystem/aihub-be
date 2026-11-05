import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma-client/client';
import { PrismaPg } from '@prisma/adapter-pg';
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { Pool } from 'pg';

import { PostgresUserAccountRepository } from '@/modules/auth/accounts/infrastructure/postgres-user-account.repository';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { PostgresUserAccessTokenRevocationRepository } from '@/modules/auth/user-access-tokens/infrastructure/postgres-user-access-token-revocation.repository';
import type { VerifiedUserAccessToken } from '@/modules/auth/web-sessions/application/user-access-token.port';
import { UserAccessJwtGuard } from '@/modules/auth/web-sessions/presentation/user-access-jwt.guard';

import { summarizeLatency } from './summary';

const RPS = 64;
const RECORD_COUNT = 1_000_000;
const DURATION_SECONDS = 60;
const WARMUP_SECONDS = 5;
const EXPECTED_DATABASE = 'aihub_revocation_benchmark';
const MARKER = 'user_access_token_revocation_benchmark';
const ISSUER = 'benchmark-issuer';
const USER_ID = 'benchmark-user';
const COMBINED_STATUS_SQL = `
  SELECT account.status,
         EXISTS (
           SELECT 1 FROM user_access_token_revocations AS revocation
           WHERE revocation.issuer = $2
             AND revocation.jti = $3
             AND revocation.effective_expires_at >= $4
         ) AS revoked
  FROM user_accounts AS account
  WHERE account.id = $1
`;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const repetition = Number(process.env.BENCHMARK_REPETITION ?? '1');
const databaseUrl = process.env.BENCHMARK_DATABASE_URL;

if (!Number.isSafeInteger(repetition) || repetition < 1 || repetition > 3) {
  throw new Error('BENCHMARK_REPETITION must be 1, 2, or 3');
}

function assertLocalBenchmarkUrl(
  value: string | undefined,
): asserts value is string {
  if (value === undefined) {
    throw new Error('BENCHMARK_DATABASE_URL is required');
  }
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (
    !['127.0.0.1', '::1'].includes(host) ||
    decodeURIComponent(url.pathname.slice(1)) !== EXPECTED_DATABASE ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    ['host', 'hostaddr', 'service', 'options'].some((key) =>
      url.searchParams.has(key),
    )
  ) {
    throw new Error(
      'benchmark accepts only its named local PostgreSQL database',
    );
  }
}

function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 12 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return { pool, prisma };
}

async function connectMarkedDatabase(connectionString: string) {
  const bootstrap = new Pool({ connectionString, max: 1 });
  try {
    const result = await bootstrap.query<{
      database_name: string;
      marker: string | null;
    }>(
      'SELECT current_database() AS database_name, current_setting($1, true) AS marker',
      ['aihub.test_lane_marker'],
    );
    const row = result.rows[0];
    if (row?.database_name !== EXPECTED_DATABASE) {
      throw new Error(
        'connected database does not match the benchmark database',
      );
    }
    if (row.marker !== MARKER) {
      throw new Error(
        'database is missing the isolated benchmark ownership marker',
      );
    }
  } finally {
    await bootstrap.end();
  }

  const connection = createDatabase(connectionString);
  const result = await connection.pool.query<{ marker: string | null }>(
    'SELECT current_setting($1, true) AS marker',
    ['aihub.test_lane_marker'],
  );
  if (result.rows[0]?.marker !== MARKER) {
    await connection.prisma.$disconnect();
    await connection.pool.end();
    throw new Error('benchmark database marker could not be verified');
  }
  return connection;
}

async function prepareDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS user_access_token_revocations');
  await pool.query('DROP TABLE IF EXISTS user_accounts');
  await pool.query(`
    CREATE TABLE user_accounts (
      id text PRIMARY KEY,
      username text NOT NULL UNIQUE,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE user_access_token_revocations (
      issuer text NOT NULL,
      jti text NOT NULL CHECK (length(jti) BETWEEN 1 AND 256),
      effective_expires_at timestamptz NOT NULL,
      PRIMARY KEY (issuer, jti)
    )
  `);
  await pool.query(`
    CREATE INDEX user_access_token_revocations_expiry_idx
    ON user_access_token_revocations (effective_expires_at)
  `);
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [USER_ID, 'benchmark-user'],
  );
  const seedResult = await pool.query(
    `INSERT INTO user_access_token_revocations (issuer, jti, effective_expires_at)
     SELECT $1, 'seeded-' || lpad(record_id::text, 7, '0'), now() + interval '20 minutes'
     FROM generate_series(1, $2::integer) AS record_id`,
    [ISSUER, RECORD_COUNT],
  );
  if (seedResult.rowCount !== RECORD_COUNT) {
    throw new Error(
      'synthetic revocation seed count did not match the scenario',
    );
  }
  await pool.query('ANALYZE user_accounts');
  await pool.query('ANALYZE user_access_token_revocations');
}

interface DatabaseSnapshot {
  readonly indexScans: number;
  readonly blocksHit: number;
  readonly blocksRead: number;
}

async function snapshotDatabase(pool: Pool): Promise<DatabaseSnapshot> {
  const [indexes, database] = await Promise.all([
    pool.query<{ index_scans: string }>(`
      SELECT COALESCE(sum(idx_scan), 0)::text AS index_scans
      FROM pg_stat_user_indexes
      WHERE relname IN ('user_accounts', 'user_access_token_revocations')
    `),
    pool.query<{ blocks_hit: string; blocks_read: string }>(`
      SELECT blks_hit::text AS blocks_hit, blks_read::text AS blocks_read
      FROM pg_stat_database
      WHERE datname = current_database()
    `),
  ]);
  return {
    indexScans: Number(indexes.rows[0]?.index_scans ?? 0),
    blocksHit: Number(database.rows[0]?.blocks_hit ?? 0),
    blocksRead: Number(database.rows[0]?.blocks_read ?? 0),
  };
}

function databaseDelta(before: DatabaseSnapshot, after: DatabaseSnapshot) {
  return {
    indexScans: after.indexScans - before.indexScans,
    blocksHit: after.blocksHit - before.blocksHit,
    blocksRead: after.blocksRead - before.blocksRead,
  };
}

function makeVerifier() {
  return {
    async verify(token: string): Promise<VerifiedUserAccessToken> {
      const requestId = token.split('.')[1];
      if (requestId === undefined) throw new Error('invalid synthetic token');
      return {
        userId: USER_ID,
        issuer: ISSUER,
        jti: `unrevoked-${requestId}`,
        validUntil: new Date(Date.now() + 60_000),
      };
    },
  };
}

function guardContext(request: FastifyRequest, reply: FastifyReply) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as Parameters<UserAccessJwtGuard['canActivate']>[0];
}

function registerGuardRoute(
  app: FastifyInstance,
  pathName: string,
  guard: Pick<UserAccessJwtGuard, 'canActivate'>,
): void {
  app.route({
    method: 'GET',
    url: `/${pathName}`,
    preHandler: async (request, reply) => {
      await guard.canActivate(guardContext(request, reply));
    },
    handler: async () => ({ ok: true }),
  });
}

async function startProbeServer(prisma: PrismaClient) {
  const verifier = makeVerifier();
  const userAccounts = new PostgresUserAccountRepository(
    prisma,
    {} as EmailOutboxPort,
  );
  const revocations = new PostgresUserAccessTokenRevocationRepository(prisma);
  const noRevocationLookup = {
    isRevoked: async () => false,
    revoke: async () => {},
  };
  const baselineGuard = new UserAccessJwtGuard(
    verifier,
    userAccounts,
    noRevocationLookup,
  );
  const exactGuard = new UserAccessJwtGuard(
    verifier,
    userAccounts,
    revocations,
  );
  const app = fastify({ logger: false });
  registerGuardRoute(app, 'baseline', baselineGuard);
  registerGuardRoute(app, 'exact', exactGuard);
  app.get('/combined', async (request, reply) => {
    const authorization = request.headers.authorization;
    const token =
      typeof authorization === 'string'
        ? authorization.split(/\s+/u)[1]
        : undefined;
    if (token === undefined) return reply.code(401).send({ ok: false });
    const verified = await verifier.verify(token);
    const rows = await prisma.$queryRawUnsafe<
      Array<{ status: string; revoked: boolean }>
    >(
      COMBINED_STATUS_SQL,
      verified.userId,
      verified.issuer,
      verified.jti,
      new Date(),
    );
    const account = rows[0];
    if (account?.status !== 'active' || account.revoked === true) {
      return reply.code(401).send({ ok: false });
    }
    return { ok: true };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('benchmark probe did not bind to a TCP port');
  }
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function runLoad(baseUrl: string, route: string, seconds: number) {
  const requestCount = RPS * seconds;
  const samples: number[] = [];
  const tasks: Array<Promise<void>> = [];
  let errors = 0;
  const startedAt = performance.now();
  for (let index = 0; index < requestCount; index += 1) {
    const dueAt = startedAt + (index * 1_000) / RPS;
    const delay = dueAt - performance.now();
    if (delay > 0) await sleep(delay);
    tasks.push(
      (async () => {
        const requestStartedAt = performance.now();
        try {
          const response = await fetch(`${baseUrl}/${route}`, {
            headers: { authorization: `Bearer bench.${index}.signature` },
          });
          await response.arrayBuffer();
          samples.push(performance.now() - requestStartedAt);
          if (!response.ok) errors += 1;
        } catch {
          errors += 1;
        }
      })(),
    );
  }
  await Promise.all(tasks);
  return {
    ...summarizeLatency(samples),
    errorCount: errors,
    offeredRequests: requestCount,
  };
}

async function main(): Promise<void> {
  assertLocalBenchmarkUrl(databaseUrl);
  const { pool, prisma } = await connectMarkedDatabase(databaseUrl);
  let app: FastifyInstance | undefined;
  try {
    await prepareDatabase(pool);
    const probe = await startProbeServer(prisma);
    app = probe.app;
    const databaseVersion = (
      await pool.query<{ server_version: string }>('SHOW server_version')
    ).rows[0]?.server_version;
    const queryPlanResult = await pool.query<{ 'QUERY PLAN': unknown[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT EXISTS (
         SELECT 1 FROM user_access_token_revocations
         WHERE issuer = $1 AND jti = $2 AND effective_expires_at >= $3
       ) AS revoked`,
      [ISSUER, 'unrevoked-plan-sample', new Date()],
    );
    const queryPlan = queryPlanResult.rows[0]?.['QUERY PLAN']?.[0] ?? null;
    const modes = [
      ['baseline', 'account-status guard; revocation read omitted'],
      ['exact', 'current guard; indexed exact revocation lookup'],
      [
        'combined',
        'candidate; account status and revocation in one SQL round trip',
      ],
    ] as const;
    const results: Array<{
      mode: string;
      description: string;
      sampleCount: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
      errorCount: number;
      offeredRequests: number;
      databaseDelta: ReturnType<typeof databaseDelta>;
    }> = [];
    for (const [route, description] of modes) {
      const warmup = await runLoad(probe.baseUrl, route, WARMUP_SECONDS);
      if (warmup.errorCount > 0) {
        throw new Error(`${route} warmup had request errors`);
      }
      const before = await snapshotDatabase(pool);
      const latency = await runLoad(probe.baseUrl, route, DURATION_SECONDS);
      const after = await snapshotDatabase(pool);
      if (latency.errorCount > 0) {
        throw new Error(
          `${route} measurement had ${latency.errorCount} request errors`,
        );
      }
      results.push({
        mode: route,
        description,
        ...latency,
        databaseDelta: databaseDelta(before, after),
      });
    }

    const report = {
      benchmark: {
        issue: 556,
        decision:
          'measurement only; no production behavior or infrastructure changed',
        scenario: {
          classification:
            'synthetic stress scenario; not a production traffic estimate',
          offeredRequestsPerSecond: RPS,
          syntheticRevocationRecords: RECORD_COUNT,
          measurementSecondsPerMode: DURATION_SECONDS,
          repetitions: 3,
          currentRepetition: repetition,
          jwtSignatureVerification:
            'stubbed to isolate guard database contribution',
        },
        combinedCandidate:
          'test-only Fastify approximation using the same stub verifier and combined SQL; it does not execute UserAccessJwtGuard',
        database: {
          version: databaseVersion,
          host: 'isolated local PostgreSQL service',
          queryPlan,
        },
        runner: {
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().length,
        },
        completedAt: new Date().toISOString(),
      },
      results,
    };
    const outputDirectory = path.join(repositoryRoot, 'temp');
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = path.join(
      outputDirectory,
      `user-access-token-revocation-benchmark-${repetition}.json`,
    );
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `Benchmark report: ${path.relative(repositoryRoot, outputPath)}`,
    );
    console.log(
      JSON.stringify(
        results.map(({ mode, p50Ms, p95Ms, p99Ms, databaseDelta }) => ({
          mode,
          p50Ms,
          p95Ms,
          p99Ms,
          databaseDelta,
        })),
        null,
        2,
      ),
    );
  } finally {
    if (app !== undefined) await app.close();
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'benchmark failed');
  process.exitCode = 1;
});
