import type { QuotaCounterPort } from '@/modules/gateway/application/quota-counter.port';
import { IdempotencyService } from '@/modules/idempotency/application/idempotency-service';
import { InMemoryIdempotencyRepository } from '@/modules/idempotency/testing/in-memory-idempotency.repository';
import { billBackgroundCompletion } from '@/modules/metering/application/background-completion-billing';
import { completeRequestMetering } from '@/modules/metering/application/metering-completion';
import type { MeteringEvidence } from '@/modules/metering/application/metering-evidence';
import { MeteringService } from '@/modules/metering/application/metering.service';
import type {
  UsageRecord,
  UsageRepositoryPort,
} from '@/modules/metering/application/usage-repository.port';

/**
 * #405: a Writing grading that outlives its `504` and is then replayed is
 * billed, and counted against quota, exactly once (ADR-0097).
 */
describe('background-completed grading billing', () => {
  const records: UsageRecord[] = [];
  const increments: string[] = [];
  const usage: UsageRepositoryPort = {
    insert: async (record) => {
      records.push(record);
    },
    aggregate: () => Promise.reject(new Error('unused')),
  };
  const quota: Pick<QuotaCounterPort, 'increment'> = {
    increment: async ({ organizationId }) => {
      increments.push(organizationId);
    },
  };
  const metering = new MeteringService(usage, undefined, quota);
  const idempotency = new IdempotencyService(
    new InMemoryIdempotencyRepository(),
  );

  function evidence(): MeteringEvidence {
    return {
      operation: 'writing.task2.grade',
      organizationId: 'org_acme',
      apiKeyId: 'ak_backend',
      environment: 'production',
      actorId: 'student_1',
      quotaTracked: true,
      settled: false,
    };
  }

  function request(
    requestId: string,
    deadlineMs: number,
    backgroundLifecycle?: ReturnType<typeof billBackgroundCompletion>,
  ) {
    return {
      organizationId: 'org_acme',
      operation: 'writing.task2.grade' as const,
      idempotencyKey: 'essay-42',
      actorId: 'student_1',
      requestBody: { essay: 'same body' },
      requestId,
      timeoutMs: 50,
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + deadlineMs),
      ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
    };
  }

  it('charges the late result once however many times it is replayed', async () => {
    let finishGrading: ((value: { score: number }) => void) | undefined;
    const grading = new Promise<{ score: number }>((resolve) => {
      finishGrading = resolve;
    });

    const first = evidence();
    await expect(
      idempotency.execute(
        request(
          'req_first',
          5,
          billBackgroundCompletion({
            requestId: 'req_first',
            receivedAt: new Date(),
            evidence: first,
            finalizer: metering,
          }),
        ),
        () => grading,
        (value) => value as { score: number },
      ),
    ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });
    await completeRequestMetering(first, metering, {
      requestId: 'req_first',
      outcome: 'downstream_error',
      httpStatus: 504,
      errorCode: 'AI_SERVICE_TIMEOUT',
      totalMs: 5,
    });

    finishGrading?.({ score: 7 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (const requestId of ['req_retry_1', 'req_retry_2']) {
      const replay = await idempotency.execute(
        request(requestId, 1_000),
        () => Promise.reject(new Error('a replay must not grade again')),
        (value) => value as { score: number },
      );
      expect(replay).toEqual({ result: { score: 7 }, replay: true });
      await completeRequestMetering(
        { ...evidence(), idempotentReplay: true },
        metering,
        { requestId, outcome: 'success', httpStatus: 200, totalMs: 3 },
      );
    }

    expect(
      records.map(({ requestId, billableRequests, billingBasis }) => ({
        requestId,
        billableRequests,
        billingBasis,
      })),
    ).toEqual([
      { requestId: 'req_first', billableRequests: 0, billingBasis: 'response' },
      {
        requestId: 'req_first:background',
        billableRequests: 1,
        billingBasis: 'background_completion',
      },
      {
        requestId: 'req_retry_1',
        billableRequests: 0,
        billingBasis: 'response',
      },
      {
        requestId: 'req_retry_2',
        billableRequests: 0,
        billingBasis: 'response',
      },
    ]);
    expect(increments).toEqual(['org_acme']);
  });
});
