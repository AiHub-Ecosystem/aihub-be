import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Redis from 'ioredis';
import { Pool, type PoolClient } from 'pg';

import { verifyDurableReads } from './n-minus-one-durable-probes';
import { verifyRedisCompatibility } from './n-minus-one-redis-probes';
import {
  CANDIDATE_PORT,
  COMPAT_DIR,
  DATABASE_URL,
  PREVIOUS_PORT,
  ROOT,
  USERNAME,
  USER_ID,
  check,
  expectStatus,
  imageConfig,
  jwt,
  organizationIdOf,
  request,
  required,
  runMigration,
  startImage,
  stopImage,
  stubState,
  waitFor,
  waitReady,
} from './n-minus-one-runtime';
import { requireSharedRedisEndpoints } from './redis-endpoint-compatibility';

async function main(): Promise<void> {
  const candidateImage = required('CANDIDATE_IMAGE');
  const previousImage = required('PREVIOUS_IMAGE');
  const candidateSha = required('CANDIDATE_SHA');
  const previousSha = required('PREVIOUS_SHA');
  const report: string[] = [];
  const failures: string[] = [];
  let redisSummary: string[] = [];
  let stubs: ChildProcess | undefined;
  let database: Pool | undefined;
  let redis: Redis | undefined;
  let outboxClaimLock: PoolClient | undefined;
  let organizationId: string | undefined;
  let userToken: string | undefined;

  const candidateDirectory = resolve(COMPAT_DIR, 'candidate');
  const previousDirectory = resolve(COMPAT_DIR, 'previous');
  mkdirSync(COMPAT_DIR, { recursive: true });
  check(
    existsSync(resolve(COMPAT_DIR, 'resend.crt')),
    'CI Resend certificate is missing',
  );
  check(
    existsSync(resolve(COMPAT_DIR, 'resend.key')),
    'CI Resend key is missing',
  );

  imageConfig(candidateDirectory, CANDIDATE_PORT, 'ci-candidate', undefined);
  imageConfig(
    previousDirectory,
    PREVIOUS_PORT,
    'ci-previous',
    candidateDirectory,
  );
  const candidateConnections = JSON.parse(
    readFileSync(
      resolve(candidateDirectory, 'connection-secrets.json'),
      'utf8',
    ),
  ) as {
    redis: { url: string; sandbox_url: string; email_send_rate_url: string };
  };
  const previousConnections = JSON.parse(
    readFileSync(resolve(previousDirectory, 'connection-secrets.json'), 'utf8'),
  ) as {
    redis: { url: string; sandbox_url: string; email_send_rate_url: string };
  };

  try {
    let fixtureHeld = false;
    try {
      requireSharedRedisEndpoints(
        {
          ...previousConnections.redis,
          url: 'redis://fixture.internal:6379/1',
        },
        {
          ...candidateConnections.redis,
          url: 'redis://fixture.internal:6379/0',
        },
        previousSha,
        candidateSha,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('RELEASE HOLD:')
      ) {
        throw error;
      }
      fixtureHeld = true;
    }
    check(
      fixtureHeld,
      'incompatible Redis fixture did not trigger the release hold',
    );
    report.push(
      `PASS: the /0-to-/1 Redis fixture triggered the held/drained gate before shared-state writes for N-1 ${previousSha} and N ${candidateSha}.`,
    );
    redisSummary = requireSharedRedisEndpoints(
      previousConnections.redis,
      candidateConnections.redis,
      previousSha,
      candidateSha,
    );

    database = new Pool({ connectionString: DATABASE_URL });
    redis = new Redis('redis://127.0.0.1:6379/0', {
      maxRetriesPerRequest: 1,
    });
    redis.on('error', () => undefined);
    await database.query('SELECT 1');
    await redis.ping();

    const writer = spawn(
      'node',
      ['scripts/ci/n-minus-one/n-minus-one-stubs.mjs'],
      {
        cwd: ROOT,
        env: { ...process.env, AIHUB_COMPAT_DIR: COMPAT_DIR },
        stdio: 'ignore',
      },
    );
    stubs = writer;
    await waitFor(
      stubState,
      (state) => Number.isInteger(state.writingCalls),
      'compatibility stubs did not start',
    );

    runMigration(candidateImage, candidateDirectory);
    await database.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, 'active', now(), now())`,
      [USER_ID, USERNAME],
    );

    const userAccessKey = JSON.parse(
      readFileSync(resolve(candidateDirectory, 'runtime-secrets.json'), 'utf8'),
    ) as { 'user-access-jwt': { private_key_pem: string } };
    userToken = jwt(userAccessKey['user-access-jwt'].private_key_pem);

    // Hold the shared poller lock so only N-1 can consume this candidate write.
    outboxClaimLock = await database.connect();
    await outboxClaimLock.query('BEGIN');
    await outboxClaimLock.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['auth-email-outbox-claim'],
    );

    // Candidate creates the organization and queued invitation before N-1 starts.
    startImage(candidateImage, 'aihub-compat-candidate', candidateDirectory);
    await waitReady(CANDIDATE_PORT, 'candidate image');
    const organizationCreateKey = `compat-org-${randomUUID()}`;
    const created = await request(CANDIDATE_PORT, 'POST', '/v1/organizations', {
      token: userToken,
      idempotencyKey: organizationCreateKey,
      body: { name: 'Release compatibility fixture' },
    });
    expectStatus(created, 201, 'candidate organization write');
    organizationId = organizationIdOf(created);
    await database.query(
      'UPDATE organizations SET max_concurrent = 1, monthly_request_quota = 3, hard_stop_on_quota = true WHERE id = $1',
      [organizationId],
    );
    const invitation = await request(
      CANDIDATE_PORT,
      'POST',
      `/v1/organizations/${organizationId}/invitations`,
      {
        token: userToken,
        idempotencyKey: `compat-invite-${randomUUID()}`,
        body: { email: 'rollback-compat@example.invalid', role: 'member' },
      },
    );
    expectStatus(invitation, 201, 'candidate email outbox write');
    stopImage('aihub-compat-candidate');
    await outboxClaimLock.query('ROLLBACK');
    outboxClaimLock.release();
    outboxClaimLock = undefined;

    startImage(previousImage, 'aihub-compat-previous', previousDirectory);
    await waitReady(PREVIOUS_PORT, 'previous Production image');
    await verifyDurableReads({
      database,
      organizationCreateKey,
      organizationId,
      userToken,
      report,
      failures,
    });

    startImage(candidateImage, 'aihub-compat-candidate', candidateDirectory);
    await waitReady(CANDIDATE_PORT, 'restarted candidate image');

    await verifyRedisCompatibility({
      database,
      redis,
      organizationId,
      userToken,
      report,
    });
  } catch (error) {
    failures.push(
      error instanceof Error ? error.message : 'N-1 compatibility check failed',
    );
  } finally {
    stopImage('aihub-compat-candidate');
    stopImage('aihub-compat-previous');
    stubs?.kill('SIGTERM');
    if (outboxClaimLock !== undefined) {
      await outboxClaimLock.query('ROLLBACK').catch(() => undefined);
      outboxClaimLock.release();
    }
    await database?.end().catch(() => undefined);
    redis?.disconnect();
  }

  const summary = [
    '## N-1 release compatibility',
    '',
    `- Candidate image: \`${candidateSha}\``,
    `- Previous Production image: \`${previousSha}\``,
    `- Redis endpoints: primary \`${redisSummary[0] ?? 'not checked'}\`, sandbox \`${redisSummary[1] ?? 'not checked'}\`, email rate \`${redisSummary[2] ?? 'not checked'}\``,
    ...report.map((line) => `- ${line}`),
    ...failures.map((line) => `- FAIL: ${line}`),
    '',
    'ADR-0122 mixed-poller account-wide Resend circuit state remains an explicit limitation; this gate checks durable outbox readability and does not assert cross-version provider-outage ownership.',
    '',
  ].join('\n');
  process.stdout.write(summary.replaceAll(/\x60/g, ''));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) writeFileSync(summaryPath, summary, { flag: 'a' });
  if (failures.length > 0) {
    throw new Error(
      `N-1 release compatibility failed (${failures.length} finding(s))`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'N-1 release compatibility failed',
  );
  process.exitCode = 1;
});
