import { strict as assert } from 'node:assert';

import * as fc from 'fast-check';

import { QuotaReconciliationService } from '@/modules/metering/application/billing/quota-reconciliation';
import type { QuotaReconciliationSnapshotPort } from '@/modules/metering/application/billing/quota-reconciliation.port';
import { quotaKeyForMonth } from '@/modules/metering/application/quota/quota-key';

import { PROPERTY_OPTIONS } from '../../../../../test/support/property-options';
import {
  monthOf,
  startOfNextMonth,
} from '../../../../../test/support/quota-months';
import type { RedisMeteringClient } from './redis-metering.client';
import { RedisQuotaCounter } from './redis-quota-counter';
import { RedisQuotaReconciliationCounter } from './redis-quota-reconciliation.counter';

/**
 * Model-based test (#329) for the monthly quota counter: generated sequences of
 * usage, Redis loss, reconciliation and clock moves run against the real
 * RedisQuotaCounter, RedisQuotaReconciliationCounter and
 * QuotaReconciliationService over an in-memory Redis, and against a model of
 * ADR-0018/0019. Redis holds a heuristic; `durable` stands in for
 * `usage_records`.
 *
 * Deliberately not covered, because the repository has not decided it yet
 * (#263, blocked by #76): admission at the limit (that decision is a Redis Lua
 * script) and a reconciliation that overlaps live traffic. Neither has a
 * documented bound to assert.
 */
const ORGANIZATION_ID = 'org_model';
const QUOTA = 1_000_000;
const START_MS = Date.UTC(2026, 0, 15, 12);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

class FakeRedis implements RedisMeteringClient {
  readonly values = new Map<string, string>();

  // The counter's only script increments a counter that already exists.
  eval(
    _script: string,
    _numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    const key = String(args[0]);
    const current = this.values.get(key);
    if (current === undefined) return Promise.resolve(0);
    const next = Number(current) + 1;
    this.values.set(key, String(next));
    return Promise.resolve(next);
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<string | null> {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  quit(): Promise<unknown> {
    return Promise.resolve('OK');
  }
}

type Command =
  | { readonly kind: 'record' }
  | { readonly kind: 'recordStartedEarlier'; readonly agoMs: number }
  | { readonly kind: 'loseCounter'; readonly monthsBack: number }
  | { readonly kind: 'reconcile'; readonly monthsBack: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'toMonthBoundary'; readonly offsetMs: -1 | 0 };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ kind: 'record' as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('recordStartedEarlier' as const),
      agoMs: fc.constantFrom(1, HOUR_MS, 3 * DAY_MS),
    }),
  },
  fc.record({
    kind: fc.constant('loseCounter' as const),
    monthsBack: fc.constantFrom(0, 1),
  }),
  fc.record({
    kind: fc.constant('reconcile' as const),
    monthsBack: fc.constantFrom(0, 1, 2),
  }),
  fc.record({
    kind: fc.constant('advance' as const),
    ms: fc.constantFrom(HOUR_MS, DAY_MS, 10 * DAY_MS, 31 * DAY_MS),
  }),
  fc.record({
    kind: fc.constant('toMonthBoundary' as const),
    offsetMs: fc.constantFrom<-1 | 0>(-1, 0),
  }),
);

class Harness {
  clockMs = START_MS;
  readonly redis = new FakeRedis();
  /** usage_records: billable requests per UTC month. */
  readonly durable = new Map<string, number>();
  /** What Redis should hold per month; absent means no key. */
  readonly expected = new Map<string, number>();

  private readonly counter = new RedisQuotaCounter(
    this.redis,
    () => new Date(this.clockMs),
    { warn: () => undefined, log: () => undefined },
  );

  private readonly snapshots: QuotaReconciliationSnapshotPort = {
    list: (target) =>
      Promise.resolve([
        {
          organizationId: ORGANIZATION_ID,
          monthlyRequestQuota: QUOTA,
          billableRequestCount: this.durable.get(target.month) ?? 0,
        },
      ]),
  };

  private readonly reconciliation = new QuotaReconciliationService(
    this.snapshots,
    new RedisQuotaReconciliationCounter(this.redis),
    () => new Date(this.clockMs),
  );

  /** A request is billed in the month it occurred in, wherever it finishes. */
  async record(occurredAtMs: number): Promise<void> {
    const month = monthOf(occurredAtMs);
    this.durable.set(month, (this.durable.get(month) ?? 0) + 1);

    const outcome = this.counter.increment({
      organizationId: ORGANIZATION_ID,
      occurredAt: new Date(occurredAtMs),
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

  loseCounter(monthsBack: number): void {
    const month = monthOf(this.clockMs, monthsBack);
    this.redis.values.delete(quotaKeyForMonth(ORGANIZATION_ID, month));
    this.expected.delete(month);
  }

  async reconcile(monthsBack: number): Promise<void> {
    const month = monthOf(this.clockMs, monthsBack);
    await this.reconciliation.reconcile(month);
    // ADR-0019: the exact run overwrites the key with the durable total.
    this.expected.set(month, this.durable.get(month) ?? 0);
  }

  assertAgrees(): void {
    const held = new Map<string, number>();
    for (const [key, value] of this.redis.values) {
      assert.match(value, /^(0|[1-9]\d*)$/);
      held.set(key.slice(key.lastIndexOf(':') + 1), Number(value));
    }

    // Redis holds exactly what the model says, and no month bleeds into another.
    assert.deepStrictEqual(held, this.expected);
    for (const [month, count] of held) {
      // A counter only ever follows a durable write, so it never runs ahead.
      assert.ok(count <= (this.durable.get(month) ?? 0));
    }
  }
}

describe('quota counter model-based properties', () => {
  it('agrees with the model over generated usage, loss, reconciliation and clock commands', async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(
          fc.array(commandArbitrary, { maxLength: 30 }),
          async (commands) => {
            const harness = new Harness();
            for (const command of commands) {
              switch (command.kind) {
                case 'record':
                  await harness.record(harness.clockMs);
                  break;
                case 'recordStartedEarlier':
                  await harness.record(harness.clockMs - command.agoMs);
                  break;
                case 'loseCounter':
                  harness.loseCounter(command.monthsBack);
                  break;
                case 'reconcile':
                  await harness.reconcile(command.monthsBack);
                  break;
                case 'advance':
                  harness.clockMs += command.ms;
                  break;
                case 'toMonthBoundary':
                  harness.clockMs =
                    startOfNextMonth(harness.clockMs) + command.offsetMs;
                  break;
              }
              harness.assertAgrees();
            }
          },
        ),
        PROPERTY_OPTIONS,
      ),
    ).resolves.toBeUndefined();
  });
});
