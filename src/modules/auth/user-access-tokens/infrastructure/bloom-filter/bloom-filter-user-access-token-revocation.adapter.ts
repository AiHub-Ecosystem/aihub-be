import {
  type ActiveRevocationRecord,
  type UserAccessTokenRevocationRecordPort,
} from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
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
  readonly waitForStoreReady?:
    | ((timeoutMs: number) => Promise<void>)
    | undefined;
  readonly channel?: string | undefined;
}

const RevocationMessageSchema = Type.Object({
  issuer: Type.String(),
  jti: Type.String(),
  effectiveExpiresAt: Type.Optional(Type.String()),
});
type RevocationMessage = Static<typeof RevocationMessageSchema>;

// A failed boot seed retries filter synchronization without delaying auth reads.
// Bounded so a down database is not hammered.
const SEED_RETRY_DELAY_MS = 10_000;
const SEED_POOL_READINESS_TIMEOUT_MS = 750;

function safeErrorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'type=UnknownError';
  }

  const value = error as Error & { readonly code?: unknown };
  const type = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : 'UnknownError';
  const code =
    typeof value.code === 'string' &&
    /^[A-Z0-9][A-Z0-9_]{0,31}$/.test(value.code)
      ? ` code=${value.code}`
      : '';
  return `type=${type}${code}`;
}

export class BloomFilterUserAccessTokenRevocationAdapter
  implements
    UserAccessTokenRevocationRecordPort,
    OnApplicationBootstrap,
    OnModuleDestroy
{
  private readonly logger = new Logger(
    BloomFilterUserAccessTokenRevocationAdapter.name,
  );
  private readonly underlying: UserAccessTokenRevocationRecordPort;
  private readonly bloomFilter: InProcessBloomFilter;
  private readonly redisPublisher: RedisPublisherPort | undefined;
  private readonly redisSubscriber: RedisSubscriberPort | undefined;
  private readonly waitForStoreReady:
    | ((timeoutMs: number) => Promise<void>)
    | undefined;
  private readonly channel: string;
  private subscribed: boolean;
  private seeded = false;
  private seedRetried = false;
  private seedReady: Promise<number> | undefined;
  private subscriberReady: Promise<void> | undefined;
  private seedRetryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BloomFilterRevocationAdapterOptions) {
    this.underlying = options.underlying;
    this.bloomFilter = options.bloomFilter ?? new InProcessBloomFilter();
    this.redisPublisher = options.redisPublisher;
    this.redisSubscriber = options.redisSubscriber;
    this.waitForStoreReady = options.waitForStoreReady;
    this.channel = options.channel ?? REVOCATION_CHANNEL_DEFAULT;
    this.subscribed = options.redisSubscriber === undefined;

    if (this.redisSubscriber) {
      this.subscriberReady = this.setupSubscriber();
    }
  }

  onApplicationBootstrap(): void {
    void this.startSeed();
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  get isSeeded(): boolean {
    return this.seeded;
  }

  async seed(now: Date = new Date()): Promise<number> {
    if (typeof this.underlying.listActiveRevocations !== 'function') {
      this.seeded = true;
      return 0;
    }
    try {
      if (this.waitForStoreReady) {
        await this.waitForStoreReady(SEED_POOL_READINESS_TIMEOUT_MS);
      }
      const active = await this.underlying.listActiveRevocations(now);
      for (const record of active) {
        this.bloomFilter.add(this.buildKey(record.issuer, record.jti));
      }
      this.seeded = true;
      if (this.seedRetryTimer !== undefined) {
        clearTimeout(this.seedRetryTimer);
        this.seedRetryTimer = undefined;
      }
      if (this.seedRetried) {
        this.logger.log(
          `Revocation filter seeded after retry with ${active.length} active record(s)`,
        );
      }
      return active.length;
    } catch (error) {
      this.seeded = false;
      this.logger.error(
        `Failed to seed token revocations from underlying store (${safeErrorDiagnostic(error)})`,
      );
      // The failure is usually a cold connection pool at boot; a bounded
      // retry restores filter synchronization without changing auth decisions.
      this.scheduleSeedRetry();
      return 0;
    }
  }

  private scheduleSeedRetry(): void {
    if (this.seedRetryTimer !== undefined) return;
    this.seedRetried = true;
    this.seedRetryTimer = setTimeout(() => {
      this.seedRetryTimer = undefined;
      void this.seed().catch(() => undefined);
    }, SEED_RETRY_DELAY_MS);
    this.seedRetryTimer.unref?.();
  }

  private startSeed(): Promise<number> {
    if (this.seedReady === undefined) {
      this.seedReady = this.seed();
    }
    return this.seedReady;
  }

  async init(now?: Date): Promise<void> {
    if (now !== undefined) {
      await this.seed(now);
    } else {
      await this.startSeed();
    }
    if (this.subscriberReady) {
      await this.subscriberReady;
    }
  }

  async isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean> {
    // A local miss cannot prove that this instance received every revocation.
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
      } catch {
        this.logger.error('Failed to broadcast token revocation');
        recordRedisUnavailable('token_revocation');
      }
    }
  }

  async listActiveRevocations(
    now: Date = new Date(),
  ): Promise<readonly ActiveRevocationRecord[]> {
    return this.underlying.listActiveRevocations(now);
  }

  async close(): Promise<void> {
    if (this.seedRetryTimer !== undefined) {
      clearTimeout(this.seedRetryTimer);
      this.seedRetryTimer = undefined;
    }
    if (this.redisSubscriber) {
      try {
        await this.redisSubscriber.unsubscribe(this.channel);
        if (
          'disconnect' in this.redisSubscriber &&
          typeof (this.redisSubscriber as { disconnect?: () => void })
            .disconnect === 'function'
        ) {
          (this.redisSubscriber as { disconnect: () => void }).disconnect();
        }
      } catch {
        // Suppress unsubscribe error on shutdown
      }
    }
    if (this.redisPublisher) {
      try {
        if (
          'disconnect' in this.redisPublisher &&
          typeof (this.redisPublisher as { disconnect?: () => void })
            .disconnect === 'function'
        ) {
          (this.redisPublisher as { disconnect: () => void }).disconnect();
        }
      } catch {
        // Suppress disconnect error on shutdown
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

    this.redisSubscriber.on('error', () => {
      this.subscribed = false;
      this.logger.error('Token revocation Redis subscriber connection error');
      recordRedisUnavailable('token_revocation');
    });

    try {
      await this.redisSubscriber.subscribe(this.channel);
      this.subscribed = true;
    } catch {
      this.subscribed = false;
      this.logger.error('Failed to subscribe to token revocation channel');
      recordRedisUnavailable('token_revocation');
    }
  }
}
