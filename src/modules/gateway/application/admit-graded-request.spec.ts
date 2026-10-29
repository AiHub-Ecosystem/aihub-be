import { AppError } from '@/common/errors/app-error';
import {
  admitGradedRequest,
  gradedAdmissionPolicy,
  gradedAdmissionRefusal,
} from './admit-graded-request';
import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
  GradedAdmissionRequest,
} from './graded-admission.port';
import {
  QUOTA_ROLLOVER_SPREAD_MS,
  quotaUnverifiableError,
} from './quota-period';

const now = () => new Date('2026-10-15T00:00:00.000Z');

function portReturning(decision: GradedAdmissionDecision): {
  readonly port: GradedAdmissionPort;
  readonly calls: GradedAdmissionRequest[];
} {
  const calls: GradedAdmissionRequest[] = [];
  return {
    calls,
    port: {
      consume: async (request) => {
        calls.push(request);
        return decision;
      },
    },
  };
}

const input = {
  apiKeyId: 'ak_1',
  rateLimitRpm: 60,
  organizationId: 'org_1',
  requestId: 'req_1',
  operation: 'writing.task1.grade',
  idempotencyKey: 'key-1',
  environment: 'production',
  monthlyRequestQuota: 100,
  hardStopOnQuota: true,
} as const;

describe('admitGradedRequest', () => {
  it('hands the port the key, quota, and hard-stop flag of a production request', async () => {
    const { port, calls } = portReturning({ stage: 'admitted' });

    await expect(admitGradedRequest(port, input)).resolves.toEqual({
      stage: 'admitted',
    });

    expect(calls).toEqual([
      {
        apiKeyId: 'ak_1',
        rateLimitRpm: 60,
        organizationId: 'org_1',
        requestId: 'req_1',
        operation: 'writing.task1.grade',
        idempotencyKey: 'key-1',
        monthlyRequestQuota: 100,
        hardStopOnQuota: true,
      },
    ]);
  });

  it('does not track a monthly quota for a sandbox key', async () => {
    const { port, calls } = portReturning({ stage: 'admitted' });

    await admitGradedRequest(port, { ...input, environment: 'sandbox' });

    expect(calls[0]?.monthlyRequestQuota).toBeNull();
  });

  it('hands a zero quota to the port as a zero, not as no quota', async () => {
    const { port, calls } = portReturning({ stage: 'admitted' });

    await admitGradedRequest(port, { ...input, monthlyRequestQuota: 0 });

    expect(calls[0]?.monthlyRequestQuota).toBe(0);
  });

  it('applies the retry budget to a Writing grade operation only', async () => {
    const { port, calls } = portReturning({ stage: 'admitted' });

    await admitGradedRequest(port, {
      ...input,
      operation: 'speaking.grading',
    });

    expect(calls[0]).not.toHaveProperty('idempotencyKey');
  });

  it('passes the decision through unchanged, including a refusal', async () => {
    const refusal = { stage: 'retry_budget', retryAfterMs: 4_000 } as const;
    const { port } = portReturning(refusal);

    await expect(admitGradedRequest(port, input)).resolves.toEqual(refusal);
  });
});

describe('gradedAdmissionPolicy', () => {
  it('keys the retry budget only for a Writing grade operation with a key', () => {
    const keyed = (operation: typeof input.operation | 'speaking.grading') =>
      gradedAdmissionPolicy({ ...input, operation, idempotencyKey: 'k' });

    expect(keyed('writing.task1.grade')).toMatchObject({
      retryBudgetKey: 'k',
      retryBudget: 'keyed_writing',
    });
    expect(keyed('speaking.grading')).toMatchObject({
      retryBudgetKey: undefined,
      retryBudget: 'none',
    });
    expect(
      gradedAdmissionPolicy({
        operation: 'writing.task1.grade',
        environment: 'production',
        monthlyRequestQuota: 100,
      }),
    ).toMatchObject({ retryBudgetKey: undefined, retryBudget: 'none' });
  });

  it('tracks a quota for a limited production key only', () => {
    expect(gradedAdmissionPolicy(input)).toMatchObject({
      quota: 100,
      quotaTracked: true,
    });
    expect(
      gradedAdmissionPolicy({ ...input, monthlyRequestQuota: 0 }),
    ).toMatchObject({ quota: 0, quotaTracked: true });
    expect(
      gradedAdmissionPolicy({ ...input, monthlyRequestQuota: null }),
    ).toMatchObject({ quota: null, quotaTracked: false });
    expect(
      gradedAdmissionPolicy({ ...input, environment: 'sandbox' }),
    ).toMatchObject({ quota: null, quotaTracked: false });
  });
});

describe('gradedAdmissionRefusal', () => {
  it('refuses a rate limit with the window reset as Retry-After', () => {
    const error = gradedAdmissionRefusal(
      { stage: 'rate_limit', retryAfterMs: 12_000 },
      'org_1',
      now,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Rate limit exceeded',
      retryable: true,
      retryAfterMs: 12_000,
    });
  });

  it('refuses a spent retry budget as RATE_LIMITED with its own message', () => {
    expect(
      gradedAdmissionRefusal(
        { stage: 'retry_budget', retryAfterMs: 61_000 },
        'org_1',
        now,
      ),
    ).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Organization retry budget exceeded',
      retryable: true,
      retryAfterMs: 61_000,
    });
  });

  it('refuses an exhausted quota as QUOTA_EXCEEDED', () => {
    expect(
      gradedAdmissionRefusal({ stage: 'quota', quota: 100 }, 'org_1', now),
    ).toMatchObject({ code: 'QUOTA_EXCEEDED', httpStatus: 429 });
  });

  it('points a December quota refusal at the first of the next year', () => {
    const december = new Date('2026-12-15T00:00:00.000Z');
    const untilJanuary =
      Date.parse('2027-01-01T00:00:00.000Z') - december.getTime();

    const error = gradedAdmissionRefusal(
      { stage: 'quota', quota: 100 },
      'org_1',
      () => december,
    );

    expect(error.retryAfterMs).toBeGreaterThanOrEqual(untilJanuary);
    expect(error.retryAfterMs).toBeLessThan(
      untilJanuary + QUOTA_ROLLOVER_SPREAD_MS,
    );
  });
});

describe('quotaUnverifiableError', () => {
  it('is a short retry, not a quota refusal with next month as its hint', () => {
    expect(quotaUnverifiableError()).toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      retryable: true,
      // The hint is spread over [base, base + 1 s) (#1352).
      retryAfterMs: expect.closeTo(1_499.5, -3) as unknown,
    });
  });
});
