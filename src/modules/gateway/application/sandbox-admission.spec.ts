import { getMetrics } from '@/common/observability/metrics';
import { isPostgresUnavailable } from '@/common/postgres/postgres-unavailable-error';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  SandboxAdmission,
  sandboxBudgetUnavailable,
} from './sandbox-admission';

async function rejectedQuotaCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="quota"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('SandboxAdmission', () => {
  function sandboxContext() {
    return createRequestContext({
      requestId: 'req_sandboxadmission',
      receivedAt: new Date(),
      deadlineMs: 5_000,
      organizationId: 'org_acme',
      environment: 'sandbox',
      scopes: [],
    });
  }

  it('answers a retryable 503 when the reservation store is down', async () => {
    const admission = new SandboxAdmission(
      {
        reserve: async () => {
          throw Object.assign(new Error('Connection terminated'), {
            name: 'PrismaClientInitializationError',
            code: 'P1001',
          });
        },
        release: async () => undefined,
        allowanceFor: async () => null,
      },
      () => undefined,
    );

    await expect(admission.admit(sandboxContext())).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });

  it('keeps a non-database admission failure out of the outage answer', () => {
    expect(
      sandboxBudgetUnavailable(new Error('policy row missing')),
    ).toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    });
    expect(isPostgresUnavailable(new Error('policy row missing'))).toBe(false);
  });

  it('counts an exhausted dispatch allowance as a quota refusal', async () => {
    const before = await rejectedQuotaCount();
    const context = createRequestContext({
      requestId: 'req_sandboxquota',
      receivedAt: new Date(),
      deadlineMs: 5_000,
      organizationId: 'org_acme',
      environment: 'sandbox',
      scopes: [],
    });
    const admission = new SandboxAdmission(
      {
        reserve: async () => false,
        release: async () => undefined,
        allowanceFor: async () => null,
      },
      () => undefined,
    );

    await expect(admission.admit(context)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(await rejectedQuotaCount()).toBe(before + 1);
  });
});
