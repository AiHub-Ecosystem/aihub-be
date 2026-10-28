import { createHash, randomUUID } from 'node:crypto';

import { ERROR_CODES } from '@/common/errors/error-code';
import Redis from 'ioredis';
import { Pool } from 'pg';

import {
  CANDIDATE_PORT,
  PREVIOUS_PORT,
  check,
  docker,
  expect2xx,
  expectStatus,
  gradeRequest,
  identityKeys,
  identityKid,
  request,
  stubState,
  waitFor,
} from './n-minus-one-runtime';

type JwksCacheMutation =
  | {
      readonly kind: 'set';
      readonly generation: string;
      readonly entry: {
        readonly jwks: { readonly keys: readonly Record<string, unknown>[] };
        readonly freshUntil: number;
        readonly staleUntil: number;
      };
    }
  | { readonly kind: 'delete' };

function mutateCandidateJwksCache(
  organizationId: string,
  configVersion: string,
  mutation: JwksCacheMutation,
): void {
  const args = [
    'exec',
    '--env',
    `AIHUB_COMPAT_OPERATION=${mutation.kind}`,
    '--env',
    `AIHUB_COMPAT_ORGANIZATION_ID=${organizationId}`,
    '--env',
    `AIHUB_COMPAT_CONFIG_VERSION=${configVersion}`,
  ];
  if (mutation.kind === 'set') {
    args.push(
      '--env',
      `AIHUB_COMPAT_GENERATION=${mutation.generation}`,
      '--env',
      `AIHUB_COMPAT_JWKS_ENTRY=${Buffer.from(JSON.stringify(mutation.entry)).toString('base64')}`,
    );
  }
  args.push(
    'aihub-compat-candidate',
    'node',
    '--input-type=commonjs',
    '-e',
    `void (async () => {
      const { RedisIdentityStore } = require('./dist/modules/identity/shared/infrastructure/redis-identity.store.js');
      const cache = new RedisIdentityStore('redis://127.0.0.1:6379/0');
      try {
        if (process.env.AIHUB_COMPAT_OPERATION === 'delete') {
          await cache.deleteJwks(
            process.env.AIHUB_COMPAT_ORGANIZATION_ID,
            process.env.AIHUB_COMPAT_CONFIG_VERSION,
          );
        } else {
          await cache.setJwks(
            process.env.AIHUB_COMPAT_ORGANIZATION_ID,
            process.env.AIHUB_COMPAT_CONFIG_VERSION,
            process.env.AIHUB_COMPAT_GENERATION,
            JSON.parse(Buffer.from(process.env.AIHUB_COMPAT_JWKS_ENTRY, 'base64').toString('utf8')),
          );
          const readBack = await cache.getJwks(process.env.AIHUB_COMPAT_ORGANIZATION_ID, process.env.AIHUB_COMPAT_CONFIG_VERSION);
          if (!readBack.entry || readBack.generation !== process.env.AIHUB_COMPAT_GENERATION) throw new Error('candidate JWKS cache fixture cannot be read');
        }
      } finally {
        await cache.onModuleDestroy();
      }
    })().catch((error) => {
      process.stderr.write(error instanceof Error ? error.message : 'candidate JWKS cache operation failed');
      process.exitCode = 1;
    });`,
  );
  docker(args);
}

export async function verifyRedisCompatibility(input: {
  readonly database: Pool;
  readonly redis: Redis;
  readonly organizationId: string;
  readonly userToken: string;
  readonly report: string[];
}): Promise<void> {
  const { database, redis, organizationId, userToken, report } = input;
  const apiKeyResponse = await request(
    CANDIDATE_PORT,
    'POST',
    `/v1/organizations/${organizationId}/api-keys`,
    {
      token: userToken,
      body: {
        name: 'N-1 compatibility key',
        scopes: ['writing.grade'],
        allowed_environments: ['production'],
      },
    },
  );
  expectStatus(apiKeyResponse, 201, 'candidate API-key write');
  const keyData = apiKeyResponse.body?.data as
    | Record<string, unknown>
    | undefined;
  check(
    typeof keyData?.api_key === 'string' && typeof keyData.id === 'string',
    'candidate API-key response is incomplete',
  );
  const apiKey = keyData.api_key;
  const apiKeyId = keyData.id;

  const issuerA = 'https://customer.compat.invalid';
  const identityA = identityKeys();
  const configA = await request(
    CANDIDATE_PORT,
    'PUT',
    `/v1/organizations/${organizationId}/identity-config`,
    {
      token: userToken,
      body: {
        issuer: issuerA,
        jwks_url: null,
        public_keys_jwks: identityA.jwks,
        allowed_algorithms: ['RS256'],
        max_assertion_ttl_seconds: 300,
      },
    },
  );
  expect2xx(configA, 'candidate JWKS write');
  const configVersionResult = await database.query<{
    configVersion: string;
  }>(
    `SELECT jwks_cache_version::text AS "configVersion"
       FROM organization_identity_configs WHERE organization_id = $1`,
    [organizationId],
  );
  const configVersion = configVersionResult.rows[0]?.configVersion;
  check(configVersion !== undefined, 'candidate JWKS config was not persisted');
  const generationKey = `aihub:v1:jwks-generation:${organizationId}`;
  const initialGeneration = (await redis.get(generationKey)) ?? '0';
  const initialJwksCacheKey = `aihub:v1:jwks:${organizationId}:${configVersion}:${initialGeneration}`;
  const initialJwksEntry = {
    jwks: identityA.jwks,
    freshUntil: Date.now() + 15 * 60_000,
    staleUntil: Date.now() + 24 * 60 * 60_000,
  };
  const remoteConfigFixture = await database.query(
    `UPDATE organization_identity_configs
       SET jwks_url = $2, public_keys_jwks = NULL
       WHERE organization_id = $1`,
    [organizationId, 'https://jwks.ci-boot.invalid/keys'],
  );
  check(
    remoteConfigFixture.rowCount === 1,
    'could not configure the cache-only JWKS fixture',
  );
  const configFixture = await database.query<{
    organizationId: string;
    jwksCacheVersion: string;
    jwksUrl: string;
    publicKeysJwks: unknown;
    status: string;
  }>(
    `SELECT organization_id AS "organizationId", issuer, jwks_url AS "jwksUrl",
            public_keys_jwks AS "publicKeysJwks", allowed_algorithms AS "allowedAlgorithms",
            max_assertion_ttl_seconds AS "maxAssertionTtlSeconds", status,
            jwks_cache_version::text AS "jwksCacheVersion"
       FROM organization_identity_configs WHERE organization_id = $1`,
    [organizationId],
  );
  const fixture = configFixture.rows[0];
  check(
    fixture?.organizationId === organizationId &&
      fixture?.jwksCacheVersion === configVersion &&
      fixture?.jwksUrl === 'https://jwks.ci-boot.invalid/keys' &&
      fixture?.publicKeysJwks === null &&
      fixture?.status === 'active',
    'JWKS identity configuration fixture is invalid',
  );
  // The production resolver blocks loopback fixtures; seed through the candidate adapter and require N-1 to read this value without a fetch fallback.
  mutateCandidateJwksCache(organizationId, configVersion, {
    kind: 'set',
    generation: initialGeneration,
    entry: initialJwksEntry,
  });
  check(
    (await redis.get(initialJwksCacheKey)) !== null,
    'candidate JWKS cache fixture was not stored in Redis',
  );
  const assertionA = identityA.signAssertion(issuerA, identityKid(identityA));
  const gradeBody = {
    question: gradeRequest.question,
    chart_type: gradeRequest.topic,
    essay: gradeRequest.essay,
    image_url: gradeRequest.url,
  };
  const gradeKey = `compat-grade-${randomUUID()}`;
  const candidateGrade = await request(
    CANDIDATE_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionA,
      idempotencyKey: gradeKey,
      body: gradeBody,
    },
  );
  const gradeError = candidateGrade.body?.error;
  if (
    typeof gradeError === 'object' &&
    gradeError !== null &&
    'code' in gradeError
  ) {
    const code = gradeError.code;
    if (
      typeof code === 'string' &&
      ERROR_CODES.some((known) => known === code)
    ) {
      check(candidateGrade.status < 400, `candidate grade: ${code}`);
    }
  }
  if (
    candidateGrade.status === 403 &&
    typeof gradeError === 'object' &&
    gradeError !== null
  ) {
    const message = (gradeError as { message?: unknown }).message;
    for (const known of [
      'API key is not authorized for this operation',
      'Organization is not active',
      'API key is not allowed in this environment',
      'Request host is not bound to an AIHUB environment',
    ]) {
      check(message !== known, `candidate grade authorization: ${known}`);
    }
  }
  expect2xx(candidateGrade, 'candidate grade and usage write');

  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
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
        const store = new RedisIdentityStore('redis://127.0.0.1:6379/0');
        const expected = JSON.parse(Buffer.from(process.env.COMPAT_RECORD, 'base64').toString('utf8'));
        try {
          if ('${operation}' === 'set') await store.set(process.env.COMPAT_HASH, expected);
          else if (JSON.stringify(await store.get(process.env.COMPAT_HASH)) !== JSON.stringify(expected)) throw new Error('N-1 API-key cache record mismatch');
        } finally { await store.onModuleDestroy(); }
      })().catch(() => { process.stderr.write('API-key cache compatibility failed'); process.exitCode = 1; });`,
    ]);
  }
  const keyTtl = await redis.pttl(`aihub:v1:key:${apiKeyHash}`);
  check(
    keyTtl > 0 && keyTtl <= 60_000,
    'API-key cache freshness is missing or exceeds its 60-second authority bound',
  );
  const serializedJwks = await redis.get(initialJwksCacheKey);
  check(
    serializedJwks !== null,
    'candidate-format JWKS cache fixture was not persisted by the identity cache adapter',
  );
  const jwksEntry = JSON.parse(serializedJwks) as {
    freshUntil?: number;
    staleUntil?: number;
  };
  const jwksTtl = await redis.pttl(initialJwksCacheKey);
  check(
    typeof jwksEntry.freshUntil === 'number' &&
      typeof jwksEntry.staleUntil === 'number' &&
      jwksEntry.staleUntil > jwksEntry.freshUntil &&
      jwksEntry.staleUntil > Date.now() &&
      jwksTtl > 0 &&
      jwksTtl <= jwksEntry.staleUntil - Date.now() + 1_000,
    'JWKS cache freshness or stale authority bounds are invalid',
  );

  const oldReplay = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionA,
      idempotencyKey: gradeKey,
      body: gradeBody,
    },
  );
  expect2xx(oldReplay, 'N-1 JWKS read and retry replay');
  const retryRefusal = await request(
    CANDIDATE_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionA,
      idempotencyKey: gradeKey,
      body: gradeBody,
    },
  );
  expectStatus(retryRefusal, 429, 'shared keyed retry-budget refusal');
  report.push(
    'PASS: N-1 read the candidate API-key cache adapter entry and replayed a request using shared JWKS state; mixed-version retry admission shared one Redis window.',
  );

  const identityB = identityA.rotate();
  const generationBefore = await redis.get(generationKey);
  mutateCandidateJwksCache(organizationId, configVersion, { kind: 'delete' });
  const generationAfter = await redis.get(generationKey);
  check(
    generationBefore !== generationAfter && generationAfter !== null,
    'candidate JWKS invalidation did not advance the shared generation',
  );
  check(
    (await redis.get(initialJwksCacheKey)) === null,
    'candidate JWKS invalidation left the previous-generation Redis entry',
  );
  const rotatedJwksEntry = {
    jwks: identityB.jwks,
    freshUntil: Date.now() + 15 * 60_000,
    staleUntil: Date.now() + 24 * 60 * 60_000,
  };
  mutateCandidateJwksCache(organizationId, configVersion, {
    kind: 'set',
    generation: generationAfter,
    entry: rotatedJwksEntry,
  });
  const staleAssertion = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionA,
      idempotencyKey: `compat-stale-jwks-${randomUUID()}`,
      body: gradeBody,
    },
  );
  expectStatus(
    staleAssertion,
    401,
    'N-1 stale JWKS rejection after generation invalidation',
  );
  const assertionB = identityB.signAssertion(issuerA, identityKid(identityB));
  report.push(
    'PASS: candidate JWKS generation invalidation reached the N-1 reader.',
  );

  const beforeHold = (await stubState()).writingCalls;
  const holdResponse = await fetch('http://127.0.0.1:18080/__compat/hold', {
    method: 'POST',
  });
  check(holdResponse.ok, 'could not arm the controlled downstream request');
  const inFlight = request(
    CANDIDATE_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionB,
      idempotencyKey: `compat-held-${randomUUID()}`,
      body: gradeBody,
    },
  );
  await waitFor(
    stubState,
    (state) => state.writingCalls > beforeHold,
    'candidate did not acquire a downstream concurrency permit',
  );
  const competing = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionB,
      idempotencyKey: `compat-competing-${randomUUID()}`,
      body: gradeBody,
    },
  );
  expectStatus(competing, 429, 'N-1 shared concurrency denial');
  await fetch('http://127.0.0.1:18080/__compat/release', { method: 'POST' });
  expect2xx(await inFlight, 'candidate concurrency lease release');
  const afterRelease = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionB,
      idempotencyKey: `compat-after-release-${randomUUID()}`,
      body: gradeBody,
    },
  );
  expect2xx(
    afterRelease,
    'N-1 acquisition after candidate released concurrency permit',
  );
  report.push(
    'PASS: real Redis enforced one N/N-1 concurrency cap and admitted N-1 after candidate released its lease.',
  );

  const usage = await database.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM usage_records WHERE organization_id = $1',
    [organizationId],
  );
  const usageCount = Number(usage.rows[0]?.count ?? 0);
  check(
    usageCount === 3,
    'candidate and N-1 did not persist the expected usage records',
  );
  const month = new Date().toISOString().slice(0, 7);
  await redis.del(`aihub:v1:quota:${organizationId}:${month}`);
  const quotaRefusal = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionB,
      idempotencyKey: `compat-durable-quota-${randomUUID()}`,
      body: gradeBody,
    },
  );
  expectStatus(quotaRefusal, 429, 'N-1 durable-usage quota rebuild');
  report.push(
    'PASS: N-1 rebuilt a missing monthly quota counter from candidate-written durable usage without flushing Redis.',
  );

  const loginBody = {
    email: 'shared-auth-window@example.invalid',
    password: 'not-a-real-password',
  };
  for (let index = 0; index < 5; index += 1) {
    const response = await request(
      index % 2 === 0 ? CANDIDATE_PORT : PREVIOUS_PORT,
      'POST',
      '/v1/auth/login',
      { body: loginBody },
    );
    check(
      response.status < 500 && response.status !== 429,
      `auth window refused before the shared limit at attempt ${index + 1}`,
    );
  }
  expectStatus(
    await request(CANDIDATE_PORT, 'POST', '/v1/auth/login', {
      body: loginBody,
    }),
    429,
    'N/N-1 shared authentication rate window',
  );
  report.push(
    'PASS: authentication rate window was shared across both image revisions.',
  );

  const keyCacheKey = `aihub:v1:key:${apiKeyHash}`;
  const keyCacheTtl = await redis.pttl(keyCacheKey);
  check(
    keyCacheTtl === -2 || (keyCacheTtl > 0 && keyCacheTtl <= 60_000),
    'N-1 API-key cache exceeded its 60-second authority bound',
  );
  const revoke = await request(
    CANDIDATE_PORT,
    'DELETE',
    `/v1/organizations/${organizationId}/api-keys/${apiKeyId}`,
    { token: userToken },
  );
  expect2xx(revoke, 'candidate API-key revocation');
  check(
    (await redis.get(keyCacheKey)) === null,
    'candidate API-key revocation did not delete the shared Redis cache entry',
  );
  // Other processes retain only the original Redis deadline (ADR-0114).
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, Math.max(0, keyCacheTtl) + 1_000),
  );
  const revokedKey = await request(
    PREVIOUS_PORT,
    'POST',
    '/v1/ielts/writing/task1/grade',
    {
      apiKey,
      assertion: assertionB,
      idempotencyKey: `compat-revoked-key-${randomUUID()}`,
      body: gradeBody,
    },
  );
  expectStatus(revokedKey, 401, 'N-1 API-key cache invalidation');
  report.push(
    'PASS: candidate API-key revocation deleted Redis state and N-1 stopped authorizing the key within the existing 60-second L1 bound.',
  );
}
