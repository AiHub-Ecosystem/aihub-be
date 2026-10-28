import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';

import { mutateCandidateJwksCache } from './n-minus-one-redis-probes';
import {
  assertNMinusOneGatePasses,
  check,
  docker,
  identityKeys,
} from './n-minus-one-runtime';

export function requirePreviousJwksFormatCompatibility(input: {
  readonly previousCanReadCandidateEntry: boolean;
  readonly previousSha: string;
  readonly candidateSha: string;
}): void {
  if (!input.previousCanReadCandidateEntry) {
    throw new Error(
      `RELEASE HOLD: N-1 ${input.previousSha} cannot read the candidate JWKS cache format from N ${input.candidateSha}`,
    );
  }
}

export function incompatibleJwksHoldReport(input: {
  readonly previousSha: string;
  readonly candidateSha: string;
}): string {
  return `N_MINUS_ONE_COMPATIBILITY_FIXTURE ${JSON.stringify({
    fixture: 'incompatible_jwks_key_format',
    fixtureResult: 'passed',
    releaseDecision: 'hold',
    previousSha: input.previousSha,
    candidateSha: input.candidateSha,
    expectedGateResult: 'failed',
    requiredAction: 'fail_release_gate_before_publish',
  })}`;
}

function readPreviousJwksEntry(
  organizationId: string,
  configVersion: string,
): 'HIT' | 'MISS' {
  const result = docker(
    [
      'exec',
      '--env',
      `AIHUB_COMPAT_ORGANIZATION_ID=${organizationId}`,
      '--env',
      `AIHUB_COMPAT_CONFIG_VERSION=${configVersion}`,
      'aihub-compat-previous',
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
        const cache = new RedisIdentityStore('', client);
        try {
          const snapshot = await cache.getJwks(process.env.AIHUB_COMPAT_ORGANIZATION_ID, process.env.AIHUB_COMPAT_CONFIG_VERSION);
          process.stdout.write(snapshot.entry === undefined ? 'MISS' : 'HIT');
        } finally { await cache.onModuleDestroy(); }
      })().catch(() => { process.stderr.write('N-1 JWKS cache read failed'); process.exitCode = 1; });`,
    ],
    true,
  ).trim();
  check(
    result === 'HIT' || result === 'MISS',
    'N-1 JWKS cache read was inconclusive',
  );
  return result;
}

export async function verifyIncompatibleJwksKeyFormat(input: {
  readonly redis: Redis;
  readonly report: string[];
  readonly previousSha: string;
  readonly candidateSha: string;
}): Promise<void> {
  const { redis, report, previousSha, candidateSha } = input;
  const organizationId = `compat-format-${randomUUID()}`;
  const configVersion = randomUUID();
  const generation = '0';
  const key = `aihub:v1:jwks:${organizationId}:${configVersion}:${generation}`;
  const incompatibleKey = key.replace('aihub:v1:', 'aihub:v2:');
  const identity = identityKeys();

  mutateCandidateJwksCache(organizationId, configVersion, {
    kind: 'set',
    generation,
    entry: {
      jwks: identity.jwks,
      freshUntil: Date.now() + 60_000,
      staleUntil: Date.now() + 120_000,
    },
  });

  // Leave the real candidate-format check uncaught so an actual incompatibility fails the release gate.
  requirePreviousJwksFormatCompatibility({
    previousCanReadCandidateEntry:
      readPreviousJwksEntry(organizationId, configVersion) === 'HIT',
    previousSha,
    candidateSha,
  });

  try {
    check(
      (await redis.get(key)) !== null,
      'candidate JWKS format fixture is missing',
    );
    check(
      (await redis.rename(key, incompatibleKey)) === 'OK',
      'could not create the incompatible JWKS key-format fixture',
    );
    const previousRead = readPreviousJwksEntry(organizationId, configVersion);
    let mismatchHold: string | undefined;
    try {
      requirePreviousJwksFormatCompatibility({
        previousCanReadCandidateEntry: previousRead === 'HIT',
        previousSha,
        candidateSha,
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      mismatchHold = error.message;
    }
    check(
      previousRead === 'MISS' &&
        mismatchHold ===
          `RELEASE HOLD: N-1 ${previousSha} cannot read the candidate JWKS cache format from N ${candidateSha}`,
      'the incompatible JWKS fixture did not produce a release hold',
    );
    let fixtureGateFailure: string | undefined;
    try {
      assertNMinusOneGatePasses([mismatchHold]);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      fixtureGateFailure = error.message;
    }
    check(
      fixtureGateFailure === 'N-1 release compatibility failed (1 finding(s))',
      'the incompatible JWKS fixture did not fail the N-1 gate',
    );
    report.push(incompatibleJwksHoldReport({ previousSha, candidateSha }));
  } finally {
    await redis.del(key, incompatibleKey);
  }
}
