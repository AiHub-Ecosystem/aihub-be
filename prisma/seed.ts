import { PrismaClient } from '@prisma-client/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const ROW_COUNT = 100_000;
const BATCH_SIZE = 1_000;
const RETENTION_SPAN_DAYS = 210;
const DAY_MS = 24 * 60 * 60 * 1_000;
const USAGE_REQUEST_PREFIX = 'aihub-benchmark-retention-';

const localHosts = new Set(['localhost', '127.0.0.1', 'postgres']);
const localDatabases = new Set(['aihub', 'aihub_benchmark']);

function localDatabaseUrl(): string {
  if (process.env.AIHUB_BENCHMARK_SEED !== '1') {
    throw new Error(
      'Set AIHUB_BENCHMARK_SEED=1 to run the local benchmark seed',
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required for the local benchmark seed');
  }

  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const hasHostOverride =
    url.searchParams.has('host') || url.searchParams.has('hostaddr');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !localHosts.has(url.hostname) ||
    !localDatabases.has(databaseName) ||
    hasHostOverride
  ) {
    throw new Error(
      'The benchmark seed is restricted to local aihub or aihub_benchmark databases',
    );
  }

  return databaseUrl;
}

function createdAtFor(index: number, now: number): Date {
  const daysAgo =
    RETENTION_SPAN_DAYS -
    Math.floor((index * RETENTION_SPAN_DAYS) / (ROW_COUNT - 1));
  return new Date(now - daysAgo * DAY_MS);
}

function requestIdFor(index: number): string {
  return `${USAGE_REQUEST_PREFIX}${String(index + 1).padStart(6, '0')}`;
}

async function seed(): Promise<void> {
  const pool = new Pool({
    connectionString: localDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 300_000,
    application_name: 'aihub-local-retention-seed',
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    await prisma.dispatchAttempt.deleteMany({
      where: { requestId: { startsWith: USAGE_REQUEST_PREFIX } },
    });
    await prisma.usageRecord.deleteMany({
      where: { requestId: { startsWith: USAGE_REQUEST_PREFIX } },
    });

    const now = Date.now();
    for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, ROW_COUNT);
      const data = Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return {
          requestId: requestIdFor(index),
          organizationId: 'org_benchmark_retention',
          apiKeyId: 'ak_benchmark_retention',
          service: 'ai-writing',
          operation: 'writing.task2.grade',
          environment: 'production',
          outcome: 'success',
          httpStatus: 200,
          billableRequests: 1,
          inputTokens: 100,
          outputTokens: 100,
          totalTokens: 200,
          meteringStatus: 'complete',
          totalMs: 2_200,
          downstreamMs: 2_000,
          aiProcessingMs: 1_800,
          createdAt: createdAtFor(index, now),
        };
      });
      await prisma.usageRecord.createMany({ data });
    }

    for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, ROW_COUNT);
      const data = Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        const createdAt = createdAtFor(index, now);
        return {
          attemptId: `b1c00000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          requestId: requestIdFor(index),
          organizationId: 'org_benchmark_retention',
          operation: 'writing.task2.grade',
          createdAt,
          unknownAfter: new Date(createdAt.getTime() + 60_000),
          outcome: 'response_received',
        };
      });
      await prisma.dispatchAttempt.createMany({ data });
    }

    await prisma.$executeRaw`ANALYZE public.usage_records`;
    await prisma.$executeRaw`ANALYZE public.dispatch_attempts`;

    const [usageCount, dispatchCount] = await Promise.all([
      prisma.usageRecord.count({
        where: { requestId: { startsWith: USAGE_REQUEST_PREFIX } },
      }),
      prisma.dispatchAttempt.count({
        where: { requestId: { startsWith: USAGE_REQUEST_PREFIX } },
      }),
    ]);

    if (usageCount !== ROW_COUNT || dispatchCount !== ROW_COUNT) {
      throw new Error('The retention benchmark seed row counts did not match');
    }

    process.stdout.write(
      `Seeded ${usageCount} usage records and ${dispatchCount} dispatch attempts over ${RETENTION_SPAN_DAYS} days.\n`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown seed error';
  process.stderr.write(`Retention benchmark seed failed: ${message}\n`);
  process.exitCode = 1;
});
