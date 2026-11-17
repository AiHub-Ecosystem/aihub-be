import { Logger } from '@nestjs/common';

import { RedisHealthReporter } from '@/common/redis/redis-health-reporter';
import { clampSheddingLevel } from '@/modules/gateway/application/shedding/request-tier';
import type { SheddingLevelPort } from '@/modules/gateway/application/shedding/shedding-level.port';
import type { RedisGatewayClient } from './redis-gateway.client';

/**
 * One key for every instance: the level is a property of the shared host.
 * Production and Sandbox run on separate Redis databases (`/0` and `/1`, each
 * with its own credentials), so this key never crosses tiers.
 */
export const SHEDDING_LEVEL_KEY = 'aihub:v1:shed:level';

/**
 * The key outlives one refresh interval by several multiples, so a process that
 * dies while shedding keeps its peers shedding for a moment rather than
 * releasing a saturated host on its own death.
 */
const SHARED_LEVEL_TTL_SECONDS = 15;

/**
 * Raises the shared level to this instance's level and refreshes the TTL. A
 * lower write never lowers the key: a peer that escalated to `2` must not be
 * talked down to `1` by an instance that has only reached `1`. Recovery happens
 * by expiry, after every instance has stopped publishing.
 */
const RAISE_LEVEL_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local level = tonumber(ARGV[1])
if level > current then current = level end
redis.call('SET', KEYS[1], tostring(current), 'EX', ARGV[2])
return current
`;

export type SheddingLevelRedisClient = Pick<RedisGatewayClient, 'get' | 'eval'>;

/**
 * The level this instance applies: the higher of its own policy and the shared
 * one. Both live in memory, so `current()` never awaits Redis; the governor
 * refreshes the shared copy on its own timer and publishes on each change.
 */
export class SheddingLevelStore implements SheddingLevelPort {
  private local = 0;
  private shared = 0;
  private readonly health: RedisHealthReporter;

  constructor(
    private readonly client?: SheddingLevelRedisClient,
    logger: Pick<Logger, 'warn' | 'log'> = new Logger(SheddingLevelStore.name),
  ) {
    this.health = new RedisHealthReporter(
      'shedding_level',
      'shedding level store',
      logger,
      'keeping the last known peer level',
    );
  }

  current(): number {
    return Math.max(this.local, this.shared);
  }

  setLocal(level: number): void {
    const next = clampSheddingLevel(level);
    this.local = next;
    if (next > 0) this.publish(next);
  }

  /** Reads a peer's level. A failed read keeps the last known value. */
  async refresh(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    try {
      const stored = await client.get(SHEDDING_LEVEL_KEY);
      this.shared = stored === null ? 0 : clampSheddingLevel(Number(stored));
      this.health.reportRecovered();
    } catch (error) {
      // Fail open: a Redis outage must not shed traffic by itself.
      this.health.reportDegraded(error);
    }
  }

  private publish(level: number): void {
    const client = this.client;
    if (client === undefined) return;
    void client
      .eval(
        RAISE_LEVEL_SCRIPT,
        1,
        SHEDDING_LEVEL_KEY,
        level,
        SHARED_LEVEL_TTL_SECONDS,
      )
      .catch((error: unknown) => this.health.reportDegraded(error));
  }
}
