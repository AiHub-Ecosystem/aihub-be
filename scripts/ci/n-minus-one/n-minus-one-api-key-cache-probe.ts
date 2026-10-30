import { createHash } from 'node:crypto';

import Redis from 'ioredis';
import { Pool } from 'pg';

import {
  CANDIDATE_PORT,
  PREVIOUS_PORT,
  check,
  docker,
  expect2xx,
  expectStatus,
  request,
} from './n-minus-one-runtime';

export async function verifyApiKeyCacheCompatibility(input: {
  readonly database: Pool;
  readonly redis: Redis;
  readonly apiKey: string;
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly assertion: string;
  readonly gradeKey: string;
  readonly gradeBody: Record<string, string>;
  readonly previousSha: string;
  readonly report: string[];
}): Promise<string> {
  const {
    database,
    redis,
    apiKey,
    apiKeyId,
    organizationId,
    assertion,
    gradeKey,
    gradeBody,
    previousSha,
    report,
  } = input;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const keyCacheKey = `aihub:v1:key:${apiKeyHash}`;
  const keyRecord = {
    organizationId,
    apiKeyId,
    organizationStatus: 'active',
    status: 'active',
    scopes: ['writing.grade'],
    entitlements: ['writing'],
    allowedEnvironments: ['production'],
    expiresAt: null,
    rateLimitRpm: 60,
    maxConcurrent: 1,
    monthlyRequestQuota: 3,
    hardStopOnQuota: true,
  };
  for (const [container, operation] of [
    ['aihub-compat-candidate', 'set'],
    ['aihub-compat-previous', 'get'],
  ] as const) {
    docker([
      'exec',
      '--env',
      `COMPAT_HASH=${apiKeyHash}`,
      '--env',
      `COMPAT_RECORD=${Buffer.from(JSON.stringify(keyRecord)).toString('base64')}`,
      container,
      'node',
      '-e',
      `void (async () => {
        const { RedisIdentityStore } = require('./dist/modules/identity/shared/infrastructure/redis-identity.store.js');
        const { readFileSync } = require('node:fs');
        const Redis = require('ioredis');
        const redisUrl = JSON.parse(readFileSync(process.env.AIHUB_RUNTIME_CONNECTION_SECRETS_FILE, 'utf8')).redis.url;
        const client = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
        client.on('error', () => {});
        await client.connect();
        const store = new RedisIdentityStore('', client);
        const expected = JSON.parse(Buffer.from(process.env.COMPAT_RECORD, 'base64').toString('utf8'));
        try {
          if ('${operation}' === 'set') await store.set(process.env.COMPAT_HASH, expected);
          else if (JSON.stringify(await store.get(process.env.COMPAT_HASH)) !== JSON.stringify(expected)) throw new Error('N-1 API-key cache record mismatch');
        } finally { await store.onModuleDestroy(); }
      })().catch(() => { process.stderr.write('API-key cache compatibility failed'); process.exitCode = 1; });`,
    ]);
  }
  const ttl = await redis.pttl(keyCacheKey);
  check(
    ttl > 0 && ttl <= 60_000,
    'API-key cache freshness is missing or exceeds its 60-second authority bound',
  );

  await database.query("UPDATE api_keys SET status = 'revoked' WHERE id = $1", [
    apiKeyId,
  ]);
  try {
    expectStatus(
      await request(PREVIOUS_PORT, 'POST', '/v1/speaking/audio/uploads', {
        apiKey,
        assertion,
        body: {},
      }),
      401,
      'N-1 grading-scope refusal of a Postgres-revoked key with an active candidate-written cache record',
    );
  } finally {
    await database.query(
      "UPDATE api_keys SET status = 'active' WHERE id = $1",
      [apiKeyId],
    );
  }
  report.push(
    `PASS: N-1 ${previousSha} read the candidate-written API-key cache record through its configured Redis endpoint, and still refused a grading-scope request once Postgres marked the key revoked (grading scopes read fresh authority, never the cache).`,
  );

  const oldReplay = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    { apiKey, assertion, idempotencyKey: gradeKey, body: gradeBody },
  );
  expect2xx(oldReplay, 'N-1 JWKS read and retry replay');
  const retryRefusal = await request(
    CANDIDATE_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    { apiKey, assertion, idempotencyKey: gradeKey, body: gradeBody },
  );
  expectStatus(retryRefusal, 429, 'shared keyed retry-budget refusal');
  report.push(
    'PASS: N-1 read the candidate API-key cache adapter entry and replayed a request using shared JWKS state; mixed-version retry admission shared one Redis window.',
  );
  return keyCacheKey;
}
