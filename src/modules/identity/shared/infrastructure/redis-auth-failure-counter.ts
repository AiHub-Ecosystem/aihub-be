import { Logger } from '@nestjs/common';

import { incrementRedisCounterWithExpiry } from '@/common/redis/increment-with-expiry';
import { RedisHealthReporter } from '@/common/redis/redis-health-reporter';
import type { AuthFailureCounterPort } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  type RedisIdentityClient,
  connectRedisIdentityClient,
} from './redis-identity-client';

export class RedisAuthFailureCounter implements AuthFailureCounterPort {
  private readonly client: RedisIdentityClient | undefined;
  // Every outage counts the metric through the shared reporter; the recovered
  // line waits until BOTH the read and write paths are healthy again, so the
  // log covers the counter as a whole rather than either half.
  private readonly health: RedisHealthReporter;
  private readonly degradedOperations = new Set<'read' | 'write'>();

  constructor(
    url: string,
    client?: RedisIdentityClient,
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(
      RedisAuthFailureCounter.name,
    ),
  ) {
    this.client = client ?? connectRedisIdentityClient(url);
    this.health = new RedisHealthReporter(
      'auth_failure_counter',
      'API-key authentication failure counter',
      logger,
      'brute-force protection is failing open until it recovers',
    );
  }

  async get(ip: string): Promise<number> {
    if (this.client === undefined) {
      return 0;
    }

    try {
      const value = await this.client.get(`aihub:v1:authfail:${ip}`);
      const count = Number(value ?? '0');
      this.reportRecovered('read');
      return Number.isInteger(count) && count >= 0 ? count : 0;
    } catch {
      this.reportDegraded('read');
      return 0;
    }
  }

  async recordFailure(ip: string): Promise<number> {
    const client = this.client;
    if (client === undefined) {
      return 0;
    }

    try {
      const key = `aihub:v1:authfail:${ip}`;
      const count = await incrementRedisCounterWithExpiry(
        (script, numberOfKeys, ...args) =>
          client.eval(script, numberOfKeys, ...args),
        key,
        300,
      );
      this.reportRecovered('write');
      return count;
    } catch {
      this.reportDegraded('write');
      return 0;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private reportDegraded(operation: 'read' | 'write'): void {
    this.degradedOperations.add(operation);
    this.health.reportDegraded();
  }

  private reportRecovered(operation: 'read' | 'write'): void {
    if (
      !this.degradedOperations.delete(operation) ||
      this.degradedOperations.size > 0
    ) {
      return;
    }

    this.health.reportRecovered();
  }
}
