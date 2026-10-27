import { AppError } from '@/common/errors/app-error';
import {
  admitGradedRequest,
  gradedAdmissionRefusal,
  retryBudgetKeyFor,
} from './admit-graded-request';
import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
  GradedAdmissionRequest,
} from './graded-admission.port';

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

describe('retry budget eligibility', () => {
  it('keys the budget only for a Writing grade operation with a key', () => {
    expect(retryBudgetKeyFor('writing.task1.grade', 'k')).toBe('k');
    expect(retryBudgetKeyFor('writing.task2.grade', 'k')).toBe('k');
    expect(retryBudgetKeyFor('writing.task1.grade', undefined)).toBeUndefined();
    expect(retryBudgetKeyFor('speaking.grading', 'k')).toBeUndefined();
    expect(retryBudgetKeyFor('speaking.grading-json', 'k')).toBeUndefined();
  });
});

describe('gradedAdmissionRefusal', () => {
  it('has no refusal for an admitted request', () => {
    expect(
      gradedAdmissionRefusal({ stage: 'admitted' }, 'org_1', now),
    ).toBeUndefined();
    expect(
      gradedAdmissionRefusal(
        { stage: 'admitted', quotaUnverified: true },
        'org_1',
        now,
      ),
    ).toBeUndefined();
  });

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
});
