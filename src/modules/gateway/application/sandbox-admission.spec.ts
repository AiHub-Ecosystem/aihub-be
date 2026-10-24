import { getMetrics } from '@/common/observability/metrics';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { SandboxAdmission } from './sandbox-admission';

async function rejectedQuotaCount(): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith('aihub_rejected_total{reason="quota"} '),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('SandboxAdmission', () => {
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
