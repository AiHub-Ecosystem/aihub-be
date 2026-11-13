import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

import * as fc from 'fast-check';
import type Redis from 'ioredis';

import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from '@/modules/gateway/infrastructure/redis-graded-admission';
import { createRedisMeteringClient } from '@/modules/metering/infrastructure/quota/redis-metering.client';
import { RedisQuotaCounter } from '@/modules/metering/infrastructure/quota/redis-quota-counter';
import { RedisQuotaReconciliationCounter } from '@/modules/metering/infrastructure/quota/redis-quota-reconciliation.counter';
import { quotaKeyForMonth } from '@/modules/metering/public/quota-counter';
import { PROPERTY_OPTIONS } from '../../support/property-options';
import { monthOf, startOfNextMonth } from '../../support/quota-months';
import { sandboxTestRedisUrl } from '../shared/database';
import { openFlushedSandboxRedis } from '../shared/flushed-sandbox-redis';

/**
 * Model-based test (#329) for monthly quota admission on a real Redis, where
 * the `count >= quota` decision lives in a Lua script that fakes cannot run.
 *
 * Generated sequences of admissions, completions (the metering increment),
 * counter loss, reconciliation and clock moves run against the real
 * RedisGradedAdmission, RedisQuotaCounter and RedisQuotaReconciliationCounter,
 * and against a model of ADR-0018/0019. Every step must agree.
 *
 * It asserts no overshoot bound: ADR-0018 accepts "bounded concurrent
 * overshoot" without a number, and #263 (blocked by #76) has not set one. The
 * concurrency property below states what the gate does today, so a bound set
 * later has a test to change.
 */
const HARD_STOP_NO_SEEDER = true;
const START_MS = Date.UTC(2026, 0, 15, 12);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RUN_TIMEOUT_MS = 120_000;
const MODEL_OPTIONS = {
  ...PROPERTY_OPTIONS,
  numRuns: 40,
  includeErrorInReport: true,
} as const;

let redis: Redis;
let gateway: RedisGatewayClient;
let admission: RedisGradedAdmission;
let counter: RedisQuotaCounter;
let reconciliation: RedisQuotaReconciliationCounter;
let metering: ReturnType<typeof createRedisMeteringClient>;
let clockMs = START_MS;

beforeAll(async () => {
  redis = await openFlushedSandboxRedis();
  const created = createRedisGatewayClient(sandboxTestRedisUrl());
  if (created === undefined) throw new Error('expected a Redis gateway client');
  gateway = created;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await gateway.ping();
      break;
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  metering = createRedisMeteringClient(sandboxTestRedisUrl());
  if (metering === undefined) throw new Error('expected a metering client');
  // Like the gateway client, it has no offline queue: wait for the socket.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await metering.get('aihub:test:metering-ready');
      break;
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const now = () => clockMs;
  admission = new RedisGradedAdmission(gateway, now);
  counter = new RedisQuotaCounter(metering, () => new Date(clockMs), {
    warn: () => undefined,
    log: () => undefined,
  });
  reconciliation = new RedisQuotaReconciliationCounter(metering);
});

afterAll(async () => {
  await gateway?.quit();
  await metering?.quit();
  await redis?.quit().catch(() => undefined);
});

type Command =
  | { readonly kind: 'admit' }
  | { readonly kind: 'complete'; readonly pick: number }
  | { readonly kind: 'loseCounter'; readonly monthsBack: number }
  | { readonly kind: 'reconcile'; readonly monthsBack: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'toMonthBoundary'; readonly offsetMs: -1 | 0 };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 5, arbitrary: fc.constant({ kind: 'admit' as const }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('complete' as const),
      pick: fc.nat(10),
    }),
  },
  fc.record({
    kind: fc.constant('loseCounter' as const),
    monthsBack: fc.constantFrom(0, 1),
  }),
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('reconcile' as const),
      monthsBack: fc.constantFrom(0, 1),
    }),
  },
  fc.record({
    kind: fc.constant('advance' as const),
    ms: fc.constantFrom(HOUR_MS, DAY_MS, 10 * DAY_MS),
  }),
  fc.record({
    kind: fc.constant('toMonthBoundary' as const),
    offsetMs: fc.constantFrom<-1 | 0>(-1, 0),
  }),
);

interface InFlight {
  /** The instant the request was admitted: the month it is billed in. */
  readonly admittedAtMs: number;
}

class Harness {
  readonly organizationId = `org_${randomUUID()}`;
  /** What Redis should hold per month; absent means no key. */
  readonly expected = new Map<string, number>();
  /** usage_records: billable requests per UTC month. */
  readonly durable = new Map<string, number>();
  readonly inFlight: InFlight[] = [];
  readonly touched = new Set<string>();

  constructor(readonly quota: number) {}

  private request() {
    return {
      apiKeyId: `ak_${randomUUID()}`,
      rateLimitRpm: 1_000_000,
      organizationId: this.organizationId,
      requestId: `req_${randomUUID()}`,
      operation: 'writing.task1.grade' as const,
      monthlyRequestQuota: this.quota,
      hardStopOnQuota: HARD_STOP_NO_SEEDER,
    };
  }

  async admit(): Promise<void> {
    const month = monthOf(clockMs);
    this.touched.add(month);
    const held = this.expected.get(month);
    if (held === undefined) {
      // A missing counter is unverifiable, not zero usage: a hard stop refuses.
      await assert.rejects(admission.consume(this.request()), {
        code: 'REDIS_UNAVAILABLE',
      });
      return;
    }
    const decision = await admission.consume(this.request());
    if (held >= this.quota) {
      assert.equal(decision.stage, 'quota');
      return;
    }
    assert.equal(decision.stage, 'admitted');
    this.inFlight.push({ admittedAtMs: clockMs });
  }

  async complete(pick: number): Promise<void> {
    if (this.inFlight.length === 0) return;
    const [done] = this.inFlight.splice(pick % this.inFlight.length, 1);
    if (done === undefined) return;
    const month = monthOf(done.admittedAtMs);
    this.touched.add(month);
    this.durable.set(month, (this.durable.get(month) ?? 0) + 1);

    const outcome = counter.increment({
      organizationId: this.organizationId,
      occurredAt: new Date(done.admittedAtMs),
    });
    const held = this.expected.get(month);
    if (held === undefined) {
      // Incrementing a missing counter would restart it at 1 and hide usage.
      await assert.rejects(outcome, /missing/);
    } else {
      await outcome;
      this.expected.set(month, held + 1);
    }
  }

  async loseCounter(monthsBack: number): Promise<void> {
    const month = monthOf(clockMs, monthsBack);
    this.touched.add(month);
    await redis.del(quotaKeyForMonth(this.organizationId, month));
    this.expected.delete(month);
  }

  async reconcile(monthsBack: number): Promise<void> {
    const month = monthOf(clockMs, monthsBack);
    this.touched.add(month);
    const count = this.durable.get(month) ?? 0;
    await reconciliation.overwrite({
      organizationId: this.organizationId,
      month,
      count,
    });
    this.expected.set(month, count);
  }

  async assertAgrees(): Promise<void> {
    for (const month of this.touched) {
      const stored = await redis.get(
        quotaKeyForMonth(this.organizationId, month),
      );
      const expected = this.expected.get(month);
      // Refusals write nothing, and the count never goes negative or bleeds
      // into another month.
      assert.equal(stored, expected === undefined ? null : String(expected));
    }
  }
}

describe('graded admission quota on a real Redis, model-based', () => {
  it(
    'agrees with the model over generated admission, completion, loss, reconciliation and clock commands',
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 4 }),
            fc.array(commandArbitrary, { maxLength: 25 }),
            async (quota, commands) => {
              clockMs = START_MS;
              const harness = new Harness(quota);
              // Start from a seeded counter so the quota edge is reachable.
              await harness.reconcile(0);
              for (const command of commands) {
                switch (command.kind) {
                  case 'admit':
                    await harness.admit();
                    break;
                  case 'complete':
                    await harness.complete(command.pick);
                    break;
                  case 'loseCounter':
                    await harness.loseCounter(command.monthsBack);
                    break;
                  case 'reconcile':
                    await harness.reconcile(command.monthsBack);
                    break;
                  case 'advance':
                    clockMs += command.ms;
                    break;
                  case 'toMonthBoundary':
                    clockMs = startOfNextMonth(clockMs) + command.offsetMs;
                    break;
                }
                await harness.assertAgrees();
              }
            },
          ),
          MODEL_OPTIONS,
        ),
      ).resolves.toBeUndefined();
    },
    RUN_TIMEOUT_MS,
  );

  // The gate only reads the counter; the increment comes later, from metering.
  // So every request that arrives while the counter is below the quota is
  // admitted, and the overshoot is the number of those requests minus the room
  // that was left. ADR-0018 accepts this as "bounded concurrent overshoot".
  it(
    'admits every concurrent request that sees the counter below the quota, so overshoot is below the number in flight',
    async () => {
      await expect(
        fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 6 }),
            fc.integer({ min: 0, max: 8 }),
            fc.integer({ min: 1, max: 12 }),
            async (quota, start, inFlight) => {
              clockMs = START_MS;
              const harness = new Harness(quota);
              const key = quotaKeyForMonth(
                harness.organizationId,
                monthOf(clockMs),
              );
              await redis.set(key, String(start));

              const decisions = await Promise.all(
                Array.from({ length: inFlight }, () =>
                  admission.consume({
                    apiKeyId: `ak_${randomUUID()}`,
                    rateLimitRpm: 1_000_000,
                    organizationId: harness.organizationId,
                    requestId: `req_${randomUUID()}`,
                    operation: 'writing.task1.grade',
                    monthlyRequestQuota: quota,
                    hardStopOnQuota: true,
                  }),
                ),
              );
              const admitted = decisions.filter(
                (decision) => decision.stage === 'admitted',
              ).length;
              assert.equal(admitted, start < quota ? inFlight : 0);
              // A refusal changes nothing.
              assert.equal(await redis.get(key), String(start));

              for (let index = 0; index < admitted; index += 1) {
                await counter.increment({
                  organizationId: harness.organizationId,
                });
              }
              const finalCount = Number(await redis.get(key));
              assert.equal(finalCount, start + admitted);
              // Overshoot the gate added: past the quota, and past whatever
              // excess the counter already held.
              assert.ok(finalCount - Math.max(quota, start) < inFlight);
            },
          ),
          MODEL_OPTIONS,
        ),
      ).resolves.toBeUndefined();
    },
    RUN_TIMEOUT_MS,
  );
});
