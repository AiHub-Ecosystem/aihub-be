import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Server, type Socket, connect, createServer } from 'node:net';

import type { ExecutionContext } from '@nestjs/common';

import { RedisDownstreamRetryBudget } from '@/modules/gateway/infrastructure/redis-downstream-retry-budget';
import { createRedisGatewayClient } from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisOrganizationRetryBudget } from '@/modules/gateway/infrastructure/redis-organization-retry-budget';
import { OrganizationRetryBudgetGuard } from '@/modules/gateway/presentation/organization-retry-budget.guard';
import type { MeteringEvidence } from '@/modules/metering/application/metering-evidence';

type FaultMode = 'normal' | 'drop' | 'slow';

class RedisFaultProxy {
  private readonly pairs = new Set<{
    readonly client: Socket;
    readonly upstream: Socket;
  }>();
  private mode: FaultMode = 'normal';
  private readonly server: Server;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {
    this.server = createServer((client) => {
      const upstream = connect({
        host: this.targetHost,
        port: this.targetPort,
      });
      const pair = { client, upstream };
      this.pairs.add(pair);
      const close = (): void => {
        this.pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close).on('close', close);
      upstream.on('error', close).on('close', close);
      client.on('data', (data) => this.forward(pair, upstream, data));
      upstream.on('data', (data) => this.forward(pair, client, data));
      if (this.mode === 'drop') close();
    });
  }

  async listen(): Promise<number> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Redis fault proxy did not bind a TCP port');
    }
    return address.port;
  }

  setMode(mode: FaultMode): void {
    this.mode = mode;
    if (mode === 'drop') {
      for (const pair of this.pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
    }
  }

  async close(): Promise<void> {
    this.setMode('drop');
    this.server.close();
    await once(this.server, 'close');
  }

  private forward(
    pair: { readonly client: Socket; readonly upstream: Socket },
    destination: Socket,
    data: Buffer,
  ): void {
    if (this.mode === 'drop') {
      pair.client.destroy();
      pair.upstream.destroy();
      return;
    }
    const write = (): void => {
      if (!destination.destroyed) destination.write(data);
    };
    if (this.mode === 'slow') setTimeout(write, 250);
    else write();
  }
}

function redisTarget(): {
  readonly host: string;
  readonly port: number;
  readonly database: string;
} {
  const target = new URL(
    process.env.TENANT_ISOLATION_REDIS_URL?.trim() ||
      'redis://127.0.0.1:6379/15',
  );
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (
    target.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '::1'].includes(host) ||
    target.pathname !== '/15' ||
    target.username !== '' ||
    target.password !== ''
  ) {
    throw new Error(
      'Retry-budget fault tests require loopback Redis database 15',
    );
  }
  return {
    host: host === 'localhost' ? '127.0.0.1' : host,
    port: Number(target.port || 6379),
    database: target.pathname,
  };
}

function requestFor(
  requestId: string,
  key: string,
  organizationId: string,
): Record<string, unknown> {
  return {
    id: requestId,
    headers: { 'idempotency-key': key },
    aihubAuth: { organizationId },
    aihubMetering: {
      operation: 'writing.task1.grade',
      organizationId,
      apiKeyId: 'ak_retry_fault_test',
      environment: 'production',
      settled: false,
    } satisfies MeteringEvidence,
  };
}

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

async function waitForRedis(
  client: NonNullable<ReturnType<typeof createRedisGatewayClient>>,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await client.ping()) === 'PONG') return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('Redis did not recover through the fault proxy');
}

describe('Organization retry-budget admission through a Redis fault proxy', () => {
  it('fails closed on Redis disconnects and slow commands, then recovers', async () => {
    const target = redisTarget();
    const proxy = new RedisFaultProxy(target.host, target.port);
    const proxyPort = await proxy.listen();
    const url = `redis://127.0.0.1:${proxyPort}${target.database}`;
    const client = createRedisGatewayClient(url);
    if (client === undefined)
      throw new Error('Retry-budget Redis client was not created');
    const guard = new OrganizationRetryBudgetGuard(
      new RedisOrganizationRetryBudget('', client),
    );
    const downstream = jest.fn();
    const organizationId = `org_retry_fault_${randomUUID().replaceAll('-', '')}`;
    const run = async (requestId: string, key: string): Promise<void> => {
      await guard.canActivate(
        contextFor(requestFor(requestId, key, organizationId)),
      );
      downstream();
    };

    try {
      await waitForRedis(client);

      const retryBucketKeys = [
        'aihub:v1:downstream-retry:{writing.task1.grade}:first',
        'aihub:v1:downstream-retry:{writing.task1.grade}:retries',
        'aihub:v1:downstream-retry:{writing.task2.grade}:first',
        'aihub:v1:downstream-retry:{writing.task2.grade}:retries',
        'aihub:v1:downstream-retry-service:{ai-writing}',
      ];
      const clearRetryBuckets = async (): Promise<void> => {
        await client.eval(
          'return redis.call("DEL", unpack(KEYS))',
          retryBucketKeys.length,
          ...retryBucketKeys,
        );
      };
      await clearRetryBuckets();
      try {
        const retryBudget = new RedisDownstreamRetryBudget(client, {
          'ai-writing': {
            ratePerSecond: 0.00001,
            burst: 1,
            expectedAttemptMs: 100,
          },
        });
        for (let index = 0; index < 10; index += 1) {
          await retryBudget.recordFirstAttempt(
            'writing.task1.grade',
            `${organizationId}-task1-${index}`,
          );
          await retryBudget.recordFirstAttempt(
            'writing.task2.grade',
            `${organizationId}-task2-${index}`,
          );
        }
        const decisions = await Promise.all([
          retryBudget.reserveRetry(
            'writing.task1.grade',
            `${organizationId}-task1-retry`,
            1,
          ),
          retryBudget.reserveRetry(
            'writing.task2.grade',
            `${organizationId}-task2-retry`,
            1,
          ),
        ]);
        expect(decisions.sort()).toEqual(['admitted', 'exhausted']);
      } finally {
        await clearRetryBuckets();
      }

      await run('retry-fault-seed', 'retry-fault-seed-key');

      proxy.setMode('drop');
      for (const [requestId, key] of [
        ['retry-fault-first-down', 'retry-fault-fresh-down-key'],
        ['retry-fault-repeat-down', 'retry-fault-seed-key'],
      ] as const) {
        await expect(run(requestId, key)).rejects.toMatchObject({
          code: 'RETRY_BUDGET_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      expect(downstream).toHaveBeenCalledTimes(1);

      proxy.setMode('normal');
      await waitForRedis(client);
      await run('retry-fault-recovered', 'retry-fault-recovered-key');

      await run('retry-fault-slow-seed', 'retry-fault-slow-seed-key');
      proxy.setMode('slow');
      for (const [requestId, key] of [
        ['retry-fault-first-slow', 'retry-fault-fresh-slow-key'],
        ['retry-fault-repeat-slow', 'retry-fault-slow-seed-key'],
      ] as const) {
        await expect(run(requestId, key)).rejects.toMatchObject({
          code: 'RETRY_BUDGET_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      expect(downstream).toHaveBeenCalledTimes(3);

      await new Promise((resolve) => setTimeout(resolve, 800));
      proxy.setMode('normal');
      await waitForRedis(client);
      await run('retry-fault-slow-recovered', 'retry-fault-slow-recovered-key');
      expect(downstream).toHaveBeenCalledTimes(4);
    } finally {
      proxy.setMode('normal');
      await client.quit();
      await proxy.close();
    }
  });
});
