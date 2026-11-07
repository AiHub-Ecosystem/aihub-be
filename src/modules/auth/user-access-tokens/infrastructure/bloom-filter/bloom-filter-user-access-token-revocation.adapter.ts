import {
  type ActiveRevocationRecord,
  type UserAccessTokenRevocationRecordPort,
} from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import { InProcessBloomFilter } from './in-process-bloom-filter';

export const REVOCATION_CHANNEL_DEFAULT = 'aihub:auth:token-revocations';

export interface RedisPublisherPort {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface RedisSubscriberPort {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface BloomFilterRevocationAdapterOptions {
  readonly underlying: UserAccessTokenRevocationRecordPort;
  readonly bloomFilter?: InProcessBloomFilter | undefined;
  readonly redisPublisher?: RedisPublisherPort | undefined;
  readonly redisSubscriber?: RedisSubscriberPort | undefined;
  readonly channel?: string | undefined;
}

const RevocationMessageSchema = Type.Object({
  issuer: Type.String(),
  jti: Type.String(),
  effectiveExpiresAt: Type.Optional(Type.String()),
});
type RevocationMessage = Static<typeof RevocationMessageSchema>;

export class BloomFilterUserAccessTokenRevocationAdapter
  implements UserAccessTokenRevocationRecordPort, OnModuleDestroy
{
  private readonly logger = new Logger(
    BloomFilterUserAccessTokenRevocationAdapter.name,
  );
  private readonly underlying: UserAccessTokenRevocationRecordPort;
  private readonly bloomFilter: InProcessBloomFilter;
  private readonly redisPublisher: RedisPublisherPort | undefined;
  private readonly redisSubscriber: RedisSubscriberPort | undefined;
  private readonly channel: string;
  private subscribed: boolean;
  private subscriberReady: Promise<void> | undefined;

  constructor(options: BloomFilterRevocationAdapterOptions) {
    this.underlying = options.underlying;
    this.bloomFilter = options.bloomFilter ?? new InProcessBloomFilter();
    this.redisPublisher = options.redisPublisher;
    this.redisSubscriber = options.redisSubscriber;
    this.channel = options.channel ?? REVOCATION_CHANNEL_DEFAULT;
    this.subscribed = options.redisSubscriber === undefined;

    if (this.redisSubscriber) {
      this.subscriberReady = this.setupSubscriber();
    }
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  async seed(now: Date = new Date()): Promise<number> {
    if (typeof this.underlying.listActiveRevocations !== 'function') {
      return 0;
    }
    try {
      const active = await this.underlying.listActiveRevocations(now);
      for (const record of active) {
        this.bloomFilter.add(this.buildKey(record.issuer, record.jti));
      }
      return active.length;
    } catch (error) {
      this.logger.error(
        'Failed to seed token revocations from underlying store',
        error,
      );
      return 0;
    }
  }

  async init(now: Date = new Date()): Promise<void> {
    await this.seed(now);
    if (this.subscriberReady) {
      await this.subscriberReady;
    }
  }

  async isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean> {
    const key = this.buildKey(input.issuer, input.jti);

    // If subscription to revocation broadcast failed, fall back to authoritative store
    // so an instance that never joined the channel does not fail open.
    if (!this.subscribed) {
      return this.underlying.isRevoked(input);
    }

    // Fast-path: Bloom filter guarantees zero false negatives.
    // If not in filter, token was definitely not revoked.
    if (!this.bloomFilter.has(key)) {
      return false;
    }

    // Slow-path: Bloom filter matched (true positive or false positive).
    // Query underlying authoritative store to confirm.
    return this.underlying.isRevoked(input);
  }

  async revoke(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }): Promise<void> {
    // Write to authoritative store first
    await this.underlying.revoke(input);

    const key = this.buildKey(input.issuer, input.jti);
    this.bloomFilter.add(key);

    if (this.redisPublisher) {
      try {
        const payload: RevocationMessage = {
          issuer: input.issuer,
          jti: input.jti,
          effectiveExpiresAt: input.effectiveExpiresAt.toISOString(),
        };
        await this.redisPublisher.publish(
          this.channel,
          JSON.stringify(payload),
        );
      } catch (error) {
        this.logger.error(
          `Failed to broadcast token revocation on channel ${this.channel}`,
          error,
        );
        recordRedisUnavailable('token_revocation');
      }
    }
  }

  async listActiveRevocations(
    now: Date = new Date(),
  ): Promise<readonly ActiveRevocationRecord[]> {
    return this.underlying.listActiveRevocations?.(now) ?? Promise.resolve([]);
  }

  async close(): Promise<void> {
    if (this.redisSubscriber) {
      try {
        await this.redisSubscriber.unsubscribe(this.channel);
      } catch {
        // Suppress unsubscribe error on shutdown
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private buildKey(issuer: string, jti: string): string {
    return JSON.stringify([issuer, jti]);
  }

  private async setupSubscriber(): Promise<void> {
    if (!this.redisSubscriber) return;

    this.redisSubscriber.on('message', (...args: unknown[]) => {
      const channel = typeof args[0] === 'string' ? args[0] : '';
      const message = typeof args[1] === 'string' ? args[1] : '';
      if (channel !== this.channel) return;
      try {
        const parsed: unknown = JSON.parse(message);
        if (Value.Check(RevocationMessageSchema, parsed)) {
          this.bloomFilter.add(this.buildKey(parsed.issuer, parsed.jti));
        }
      } catch {
        // Ignore malformed broadcast messages
      }
    });

    this.redisSubscriber.on('error', (error) => {
      this.subscribed = false;
      this.logger.error(
        `Token revocation Redis subscriber connection error on channel ${this.channel}`,
        error,
      );
      recordRedisUnavailable('token_revocation');
    });

    try {
      await this.redisSubscriber.subscribe(this.channel);
      this.subscribed = true;
    } catch (error) {
      this.subscribed = false;
      this.logger.error(
        `Failed to subscribe to token revocation channel ${this.channel}`,
        error,
      );
      recordRedisUnavailable('token_revocation');
    }
  }
}
