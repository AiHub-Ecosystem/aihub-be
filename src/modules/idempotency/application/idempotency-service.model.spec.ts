import { strict as assert } from 'node:assert';

import * as fc from 'fast-check';

import { AppError } from '@/common/errors/app-error';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';

import { PROPERTY_OPTIONS } from '../../../../test/support/property-options';
import { createIdempotencyFingerprint } from './idempotency-fingerprint';
import {
  IDEMPOTENCY_RETENTION_MS,
  IdempotencyService,
} from './idempotency-service';
import type { IdempotencyExecution } from './idempotency-service.port';

/**
 * Model-based test (#329): generated command sequences run against the real
 * IdempotencyService over the in-memory repository, and against a small model
 * of the intended rules. Every step must agree. A failure shrinks to the
 * shortest sequence of commands that breaks a rule.
 */
const OPERATION = 'organizations.create' as const;
const ORGANIZATION_ID = 'org_model';
const ACTOR_ID = 'user_model';
const KEY = 'key-1';
const BODIES = [{ answer: 'a' }, { answer: 'b' }] as const;
const START_MS = Date.UTC(2026, 0, 1);
const TIMEOUT_MS = 1_000_000;

type BodyIndex = 0 | 1;
type Outcome = 'ok' | 'server-error' | 'client-error';

type Command =
  | { readonly kind: 'start'; readonly body: BodyIndex }
  | {
      readonly kind: 'finish';
      readonly attempt: number;
      readonly outcome: Outcome;
    }
  | { readonly kind: 'crash'; readonly attempt: number }
  | { readonly kind: 'request'; readonly body: BodyIndex }
  | { readonly kind: 'advance'; readonly ms: number };

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant('start' as const),
    body: fc.constantFrom<BodyIndex>(0, 1),
  }),
  fc.record({
    kind: fc.constant('finish' as const),
    attempt: fc.nat(5),
    outcome: fc.constantFrom<Outcome>('ok', 'server-error', 'client-error'),
  }),
  fc.record({ kind: fc.constant('crash' as const), attempt: fc.nat(5) }),
  fc.record({
    kind: fc.constant('request' as const),
    body: fc.constantFrom<BodyIndex>(0, 1),
  }),
  fc.record({
    kind: fc.constant('advance' as const),
    ms: fc.constantFrom(
      1_000,
      IDEMPOTENCY_RETENTION_MS - 1,
      IDEMPOTENCY_RETENTION_MS,
    ),
  }),
);

/** What the key's stored record should look like, by the documented rules. */
interface ModelRecord {
  state: 'pending' | 'completed' | 'failed';
  body: BodyIndex;
  /** Which start() currently owns a pending record; undefined once reclaimed. */
  owner: number | undefined;
  expiresAt: number;
}

interface Attempt {
  readonly body: BodyIndex;
  readonly settle: (outcome: Outcome) => void;
  readonly done: Promise<IdempotencyExecution<string> | AppError>;
  live: boolean;
}

function serverError(): Error {
  return new Error('downstream exploded');
}

function clientError(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'bad input',
    retryable: false,
  });
}

class Harness {
  clockMs = START_MS;
  executions = 0;
  readonly repository = new InMemoryIdempotencyRepository(() => this.clockMs);
  readonly service = new IdempotencyService(
    this.repository,
    () => this.clockMs,
    () => 0.5,
  );
  readonly attempts: Attempt[] = [];
  model: ModelRecord | undefined;
  expectedExecutions = 0;

  private input(body: BodyIndex, requestId: string) {
    return {
      organizationId: ORGANIZATION_ID,
      operation: OPERATION,
      idempotencyKey: KEY,
      actorId: ACTOR_ID,
      requestBody: BODIES[body],
      requestId,
      timeoutMs: TIMEOUT_MS,
      signal: new AbortController().signal,
      deadlineAt: new Date(this.clockMs + TIMEOUT_MS),
    };
  }

  /** The model's answer to "would a request for `body` start downstream work?" */
  private claims(body: BodyIndex): boolean {
    const record = this.model;
    if (record === undefined || record.expiresAt <= this.clockMs) return true;
    return record.body === body && record.state === 'failed';
  }

  private claim(body: BodyIndex, owner: number | undefined): void {
    this.model = {
      state: 'pending',
      body,
      owner,
      expiresAt: this.clockMs + IDEMPOTENCY_RETENTION_MS,
    };
    this.expectedExecutions += 1;
  }

  /** Resolves once the service has either begun the work or answered without it. */
  async start(body: BodyIndex): Promise<void> {
    const index = this.attempts.length;
    let settle: (outcome: Outcome) => void = () => undefined;
    const gate = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    let begun: () => void = () => undefined;
    const workBegun = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const willClaim = this.claims(body);
    if (willClaim) this.claim(body, index);
    const done = this.service
      .execute<string>(
        this.input(body, `request-${index}`),
        async () => {
          this.executions += 1;
          begun();
          const outcome = await gate;
          if (outcome === 'server-error') throw serverError();
          if (outcome === 'client-error') throw clientError();
          return `result-${index}`;
        },
        (stored) => String(stored),
      )
      .catch((error: unknown) =>
        error instanceof AppError
          ? error
          : new AppError({
              code: 'INTERNAL_ERROR',
              message: 'unexpected',
              retryable: false,
              cause: error,
            }),
      );
    this.attempts.push({ body, settle, done, live: willClaim });
    await Promise.race([workBegun, done]);
  }

  async finish(index: number, outcome: Outcome): Promise<void> {
    const attempt = this.attempts[index];
    if (attempt === undefined || !attempt.live) return;
    attempt.live = false;
    attempt.settle(outcome);
    await attempt.done;
    const record = this.model;
    if (record?.owner === index) {
      record.owner = undefined;
      if (outcome === 'ok') record.state = 'completed';
      else if (outcome === 'client-error') this.model = undefined;
      else record.state = 'failed';
    }
  }

  /** The process died: the attempt never reports back and its record stays pending. */
  crash(index: number): void {
    const attempt = this.attempts[index];
    if (attempt === undefined) return;
    attempt.live = false;
  }

  async request(body: BodyIndex): Promise<void> {
    const before = this.executions;
    const willClaim = this.claims(body);
    const record = this.model;
    const expectsReplay =
      !willClaim && record?.state === 'completed' && record.body === body;
    const expectsRetryableConflict =
      !willClaim && record?.state === 'pending' && record.body === body;
    const index = this.attempts.length;
    this.attempts.push({
      body,
      settle: () => undefined,
      done: Promise.resolve(
        new AppError({ code: 'INTERNAL_ERROR', message: '', retryable: false }),
      ),
      live: false,
    });

    let outcome: IdempotencyExecution<string> | AppError;
    try {
      outcome = await this.service.execute<string>(
        this.input(body, `request-${index}`),
        () => {
          this.executions += 1;
          return Promise.resolve(`result-${index}`);
        },
        (stored) => String(stored),
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      outcome = error;
    }

    if (willClaim) {
      this.claim(body, undefined);
      if (this.model !== undefined) this.model.state = 'completed';
      assert.deepStrictEqual(outcome, {
        result: `result-${index}`,
        replay: false,
      });
      assert.equal(this.executions, before + 1);
      return;
    }

    // Never a second downstream call while a record is held for this key.
    assert.equal(this.executions, before);
    if (expectsReplay) {
      assert.ok(!(outcome instanceof AppError) && outcome.replay);
    } else {
      assert.ok(outcome instanceof AppError);
      assert.equal(outcome.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(outcome.retryable, expectsRetryableConflict);
    }
  }

  advance(ms: number): void {
    this.clockMs += ms;
  }

  /** Cross-check the store against the model through the repository's public seam. */
  async assertAgrees(): Promise<void> {
    assert.equal(this.executions, this.expectedExecutions);
    const live =
      this.model !== undefined && this.model.expiresAt > this.clockMs;
    for (const body of [0, 1] as const) {
      const match = await this.repository.findCompletedMatch({
        organizationId: ORGANIZATION_ID,
        operation: OPERATION,
        actorScope: '',
        idempotencyKey: KEY,
        fingerprintHex: createIdempotencyFingerprint({
          organizationId: ORGANIZATION_ID,
          operation: OPERATION,
          actorId: ACTOR_ID,
          requestBody: BODIES[body],
        }),
      });
      const expectsCompleted =
        live && this.model?.state === 'completed' && this.model.body === body;
      // One completed record per key and fingerprint: only the model's body matches.
      assert.equal(match !== undefined, expectsCompleted);
    }
  }

  /** Settle every attempt still holding a timer, so the run leaves nothing behind. */
  async drain(): Promise<void> {
    for (const attempt of this.attempts) attempt.settle('server-error');
    await Promise.all(this.attempts.map((attempt) => attempt.done));
  }
}

describe('IdempotencyService model-based properties', () => {
  it('agrees with the model over generated start, finish, crash, request and clock commands', async () => {
    await expect(
      fc.assert(
        fc.asyncProperty(
          fc.array(commandArbitrary, { maxLength: 25 }),
          async (commands) => {
            const harness = new Harness();
            try {
              for (const command of commands) {
                switch (command.kind) {
                  case 'start':
                    await harness.start(command.body);
                    break;
                  case 'finish':
                    await harness.finish(command.attempt, command.outcome);
                    break;
                  case 'crash':
                    harness.crash(command.attempt);
                    break;
                  case 'request':
                    await harness.request(command.body);
                    break;
                  case 'advance':
                    harness.advance(command.ms);
                    break;
                }
                await harness.assertAgrees();
              }
            } finally {
              await harness.drain();
            }
          },
        ),
        PROPERTY_OPTIONS,
      ),
    ).resolves.toBeUndefined();
  });
});
