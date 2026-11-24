import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import type { Pool } from 'pg';

import { getMetrics } from '@/common/observability/metrics/metrics';
import {
  REDIS_NO_REPLAY_OPTIONS,
  createRedisClient,
} from '@/common/redis/create-redis-client';
import { BloomFilterUserAccessTokenRevocationAdapter } from '@/modules/auth/user-access-tokens/infrastructure/bloom-filter/bloom-filter-user-access-token-revocation.adapter';
import { PostgresUserAccessTokenRevocationRepository } from '@/modules/auth/user-access-tokens/infrastructure/postgres-user-access-token-revocation.repository';

import { createPostgresAuthClient } from '../../auth/postgres-auth.client';
import { createTestPool, testDatabaseUrl } from '../../shared/database';

import type {
  FaultMode,
  TcpFaultProxy,
} from '../../../support/tcp-fault-proxy';
import {
  eventually,
  redisThroughProxy,
  redisUnavailableCount,
  timed,
} from './fault-targets';

// The User Access JWT revocation row of the #2019 matrix: PostgreSQL is the
// authority, Redis Pub/Sub only feeds a local Bloom filter.
const ISSUER = 'https://api.revocation-fault.test';
// The publisher's command timeout is 500 ms.
const PUBLISH_BOUND_MS = 1_500;

let pool: Pool;
let authClient: ReturnType<typeof createPostgresAuthClient>;
let proxy: TcpFaultProxy;
let proxiedUrl: string;
const adapters: BloomFilterUserAccessTokenRevocationAdapter[] = [];

/** Built as auth-runtime.module.ts builds it, against the proxied Redis. */
function adapter(withSubscriber: boolean) {
  const subscriber = withSubscriber
    ? new Redis(proxiedUrl, {
        lazyConnect: true,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        connectTimeout: 1_000,
      })
    : undefined;
  subscriber?.on('error', () => undefined);
  const publisher = createRedisClient(proxiedUrl, {
    commandTimeoutMs: 500,
    ...REDIS_NO_REPLAY_OPTIONS,
  });
  publisher.on('error', () => undefined);
  const created = new BloomFilterUserAccessTokenRevocationAdapter({
    underlying: new PostgresUserAccessTokenRevocationRepository(authClient),
    redisPublisher: publisher,
    redisSubscriber: subscriber,
  });
  adapters.push(created);
  return { adapter: created, publisher };
}

async function subscriberUp(): Promise<number | undefined> {
  const line = (await getMetrics())
    .split('\n')
    .find((candidate) =>
      candidate.startsWith('aihub_token_revocation_subscriber_up '),
    );
  return line === undefined ? undefined : Number(line.split(' ')[1]);
}

function token() {
  return {
    issuer: ISSUER,
    jti: `jti_${randomUUID()}`,
    effectiveExpiresAt: new Date(Date.now() + 15 * 60_000),
  };
}

beforeAll(async () => {
  pool = createTestPool();
  authClient = createPostgresAuthClient(testDatabaseUrl());
  const target = await redisThroughProxy();
  proxy = target.proxy;
  proxiedUrl = target.url;
});

afterEach(async () => {
  await proxy.setMode('normal');
  await Promise.all(adapters.splice(0).map((created) => created.close()));
});

afterAll(async () => {
  await pool.query(
    'DELETE FROM user_access_token_revocations WHERE issuer = $1',
    [ISSUER],
  );
  await proxy.close();
  await authClient.close();
  await pool.end();
});

describe('User Access JWT revocation while Redis is down', () => {
  it.each<FaultMode>(['refuse', 'hang'])(
    'commits the revocation and rejects the token everywhere when the publish fails because Redis is %s',
    async (mode) => {
      const { adapter: issuing, publisher } = adapter(false);
      const revoked = token();
      // A publisher that has not connected yet fails at once, which would
      // prove nothing about the fault.
      await eventually(async () => (await publisher.ping()) === 'PONG');
      const before = await redisUnavailableCount('token_revocation');

      await proxy.setMode(mode);
      const call = await timed(() => issuing.revoke(revoked));

      // The revoke response does not change: the broadcast is best-effort.
      expect(call.result.status).toBe('fulfilled');
      expect(call.ms).toBeLessThan(PUBLISH_BOUND_MS);
      expect(await redisUnavailableCount('token_revocation')).toBe(before + 1);
      // A process that never heard the broadcast asks PostgreSQL.
      const peer = new PostgresUserAccessTokenRevocationRepository(authClient);
      await expect(
        peer.isRevoked({ ...revoked, now: new Date() }),
      ).resolves.toBe(true);
    },
  );

  it('keeps rejecting revoked tokens from PostgreSQL while the subscriber is down, and resubscribes once Redis returns', async () => {
    const revoked = token();
    await new PostgresUserAccessTokenRevocationRepository(authClient).revoke(
      revoked,
    );

    await proxy.setMode('refuse');
    const { adapter: listening } = adapter(true);

    expect(listening.isSubscribed).toBe(false);
    expect(await subscriberUp()).toBe(0);
    await expect(
      listening.isRevoked({ ...revoked, now: new Date() }),
    ).resolves.toBe(true);
    await expect(
      listening.isRevoked({ ...token(), now: new Date() }),
    ).resolves.toBe(false);

    await proxy.setMode('normal');
    await eventually(async () => listening.isSubscribed, 10_000);
    expect(await subscriberUp()).toBe(1);
  }, 20_000);
});
