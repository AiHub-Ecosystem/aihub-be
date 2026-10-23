import { AppError } from '@/common/errors/app-error';
import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';

import {
  BACKPRESSURE_MAX_RETRY_MS,
  BACKPRESSURE_MIN_RETRY_MS,
  EmailOutboxBackpressureGate,
} from './email-outbox-backpressure.gate';
import type {
  BackpressureEmailKind,
  EmailOutboxQueueAgePort,
} from './email-outbox-backpressure.port';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function gateWith(
  age: number | undefined | Error,
  refused: BackpressureEmailKind[] = [],
): EmailOutboxBackpressureGate {
  const queueAge: EmailOutboxQueueAgePort = {
    oldestQueuedAgeSeconds: async () => {
      if (age instanceof Error) throw age;
      return age === undefined ? undefined : age / 1000;
    },
  };
  return new EmailOutboxBackpressureGate(
    queueAge,
    (kind) => refused.push(kind),
    () => 0,
  );
}

async function refusalOf(
  gate: EmailOutboxBackpressureGate,
  kind: BackpressureEmailKind,
): Promise<AppError | undefined> {
  try {
    await gate.admit(kind);
    return undefined;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

describe('EmailOutboxBackpressureGate', () => {
  it.each<[BackpressureEmailKind, number]>([
    ['password_reset_email', OPAQUE_TOKEN_BINDINGS.passwordReset.ttlMs],
    ['verification_email', OPAQUE_TOKEN_BINDINGS.verification.ttlMs],
    [
      'organization_invite_email',
      OPAQUE_TOKEN_BINDINGS.organizationInvite.ttlMs,
    ],
  ])(
    'refuses %s once the backlog uses 75 percent of its credential lifetime',
    async (kind, ttlMs) => {
      const threshold = ttlMs * 0.75;

      expect(await refusalOf(gateWith(threshold - 1), kind)).toBeUndefined();
      const refusal = await refusalOf(gateWith(threshold), kind);

      expect(refusal).toMatchObject({
        code: 'EMAIL_DELIVERY_BACKLOGGED',
        retryable: true,
      });
    },
  );

  it('names the documented thresholds: 45 minutes for a reset, 18 hours for a 24-hour token', async () => {
    expect(
      await refusalOf(gateWith(45 * MINUTE - 1), 'password_reset_email'),
    ).toBeUndefined();
    expect(
      await refusalOf(gateWith(45 * MINUTE), 'password_reset_email'),
    ).toBeDefined();
    expect(
      await refusalOf(gateWith(18 * HOUR - 1), 'verification_email'),
    ).toBeUndefined();
    expect(
      await refusalOf(gateWith(18 * HOUR), 'verification_email'),
    ).toBeDefined();
  });

  it('asks the caller to wait until the oldest request would expire, within bounds', async () => {
    const nearTtl = await refusalOf(
      gateWith(55 * MINUTE),
      'password_reset_email',
    );
    const longWait = await refusalOf(gateWith(19 * HOUR), 'verification_email');
    const overdue = await refusalOf(gateWith(2 * HOUR), 'password_reset_email');

    expect(nearTtl?.retryAfterMs).toBe(5 * MINUTE);
    expect(longWait?.retryAfterMs).toBe(BACKPRESSURE_MAX_RETRY_MS);
    expect(overdue?.retryAfterMs).toBe(BACKPRESSURE_MIN_RETRY_MS);
  });

  it('spreads the wait, never shortens it, so refused callers do not return together', async () => {
    const gate = new EmailOutboxBackpressureGate(
      { oldestQueuedAgeSeconds: async () => 55 * 60 },
      () => undefined,
      () => 0.5,
    );

    const refusal = await refusalOf(gate, 'password_reset_email');

    expect(refusal?.retryAfterMs).toBe(5 * MINUTE + 500);
  });

  it('admits when the queue age is unknown, because a missing signal is not a reason to refuse', async () => {
    expect(
      await refusalOf(gateWith(undefined), 'verification_email'),
    ).toBeUndefined();
  });

  it('admits when the queue age cannot be read', async () => {
    expect(
      await refusalOf(
        gateWith(new Error('database down')),
        'verification_email',
      ),
    ).toBeUndefined();
  });

  it('reports a refusal by kind, and only a refusal', async () => {
    const refused: BackpressureEmailKind[] = [];

    await refusalOf(gateWith(18 * HOUR, refused), 'verification_email');
    await refusalOf(gateWith(0, refused), 'verification_email');

    expect(refused).toEqual(['verification_email']);
  });
});
