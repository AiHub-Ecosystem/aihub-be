import type { ExecutionContext } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { getMetrics } from '@/common/observability/metrics';
import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
  GradedAdmissionRequest,
} from '@/modules/gateway/application/graded-admission.port';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type { AuthenticatedApiKey } from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import {
  getMeteringEvidence,
  openMeteringEvidence,
} from '@/modules/metering/application/metering-evidence';
import { takeCompletedReplay } from './completed-idempotency-replay';
import { GradedAdmissionGuard } from './graded-admission.guard';

const authenticated: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: 5,
  hardStopOnQuota: false,
  allowedEnvironments: ['production'],
};

const standing = { limit: 600, remaining: 41, resetInMs: 12_001 };
const now = () => new Date('2026-09-16T12:00:00.000Z');

const WRITING_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'The chart shows a clear trend.',
  image_url: 'https://example.com/chart.png',
};

async function rejectedCount(reason: string): Promise<number> {
  const line = (await getMetrics())
    .split('\n')
    .find((sample) =>
      sample.startsWith(`aihub_rejected_total{reason="${reason}"} `),
    );
  return Number(line?.split(' ').at(-1) ?? 0);
}

function contextFor(
  request: Record<string, unknown>,
  headers = new Map<string, string>(),
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({
        header: (name: string, value: string) => headers.set(name, value),
      }),
    }),
  } as ExecutionContext;
}

function requestFor(
  operation: OperationId = 'writing.task1.grade',
  key?: string,
  key_auth: AuthenticatedApiKey = authenticated,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    id: 'req_01JGRADINGADMISSION0000000000',
    raw: {},
    headers: key === undefined ? {} : { 'idempotency-key': key },
    body: WRITING_BODY,
    aihubAuth: key_auth,
    routeOptions: { url: OPERATION_CATALOG[operation].path },
    aihubIdentity: { mode: 'declared_id', userId: 'user_acme' },
  };
  // The authenticating guard opens the evidence before this guard runs.
  openMeteringEvidence(request, {
    operation,
    organizationId: key_auth.organizationId,
    apiKeyId: key_auth.apiKeyId,
    environment: key_auth.environment,
  });
  return request;
}

function portReturning(decision: GradedAdmissionDecision): {
  readonly port: GradedAdmissionPort;
  readonly calls: GradedAdmissionRequest[];
} {
  const calls: GradedAdmissionRequest[] = [];
  return {
    calls,
    port: {
      consume: async (input) => {
        calls.push(input);
        return decision;
      },
    },
  };
}

function guardFor(
  decision: GradedAdmissionDecision,
  idempotency?: IdempotencyServicePort,
): {
  readonly guard: GradedAdmissionGuard;
  readonly calls: GradedAdmissionRequest[];
} {
  const { port, calls } = portReturning(decision);
  return { guard: new GradedAdmissionGuard(port, idempotency, now), calls };
}

function replayService(found: boolean): {
  readonly service: IdempotencyServicePort;
  readonly findCompletedReplay: jest.Mock;
} {
  const findCompletedReplay = jest.fn().mockResolvedValue(
    found
      ? {
          responseStatus: 200,
          responseBody: { operation: 'writing.task1.grade', data: {} },
        }
      : undefined,
  );
  return {
    findCompletedReplay,
    service: { findCompletedReplay } as unknown as IdempotencyServicePort,
  };
}

describe('GradedAdmissionGuard', () => {
  it('admits through the use case with the caller key and its own limits', async () => {
    const { guard, calls } = guardFor({ stage: 'admitted' });
    const request = requestFor('writing.task1.grade', ' retry-1 ');

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(calls).toEqual([
      {
        apiKeyId: 'ak_backend',
        rateLimitRpm: 600,
        organizationId: 'org_acme',
        requestId: 'req_01JGRADINGADMISSION0000000000',
        operation: 'writing.task1.grade',
        idempotencyKey: 'retry-1',
        monthlyRequestQuota: 5,
        hardStopOnQuota: false,
      },
    ]);
  });

  it.each([
    ['Speaking', 'speaking.grading', 'retry-3'],
    ['a missing key', 'writing.task1.grade', undefined],
    ['a malformed key', 'writing.task1.grade', ' '.repeat(300)],
  ] as const)(
    'leaves the retry budget out for %s and does not reinterpret a malformed key',
    async (_label, operation, key) => {
      const { guard, calls } = guardFor({ stage: 'admitted' });
      const request = requestFor(operation, key);

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

      expect(calls[0]).not.toHaveProperty('idempotencyKey');
      expect(getMeteringEvidence(request)?.gradedRequestTiming).toMatchObject({
        retryBudget: 'none',
      });
    },
  );

  it('records that a keyed Writing request is under the retry budget', async () => {
    const { guard } = guardFor({ stage: 'admitted' });
    const request = requestFor('writing.task1.grade', 'retry-1');

    await guard.canActivate(contextFor(request));

    expect(getMeteringEvidence(request)?.gradedRequestTiming).toMatchObject({
      identityMode: 'declared_id',
      retryBudget: 'keyed_writing',
    });
  });

  it('reports the per-key standing on an admitted request', async () => {
    const headers = new Map<string, string>();
    const { guard } = guardFor({ stage: 'admitted', rate: standing });

    await guard.canActivate(contextFor(requestFor(), headers));

    expect(Object.fromEntries(headers)).toEqual({
      'RateLimit-Policy': '"per-key";q=600;w=60',
      RateLimit: '"per-key";r=41;t=13',
    });
  });

  it('refuses a rate limit, reports the standing next to the hint, and counts it once', async () => {
    const before = await rejectedCount('rate_limit');
    const headers = new Map<string, string>();
    const { guard } = guardFor({
      stage: 'rate_limit',
      retryAfterMs: 12_500,
      rate: { ...standing, remaining: 0 },
    });

    await expect(
      guard.canActivate(contextFor(requestFor(), headers)),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 12_500 });

    expect(headers.get('RateLimit')).toBe('"per-key";r=0;t=13');
    expect(await rejectedCount('rate_limit')).toBe(before + 1);
  });

  it('refuses a spent retry budget as a retryable 429', async () => {
    const { guard } = guardFor({ stage: 'retry_budget', retryAfterMs: 61_250 });

    await expect(
      guard.canActivate(contextFor(requestFor('writing.task2.grade', 'k'))),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Organization retry budget exceeded',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 61_250,
    });
  });

  it('refuses an exhausted quota, marks the request tracked, and counts it once', async () => {
    const before = await rejectedCount('quota');
    const { guard } = guardFor({ stage: 'quota', quota: 5 });
    const request = requestFor();

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      httpStatus: 429,
      retryable: true,
    });

    expect(await rejectedCount('quota')).toBe(before + 1);
    expect(getMeteringEvidence(request)).toEqual(
      expect.objectContaining({ quotaTracked: true }),
    );
  });

  it('lets an exact completed Writing replay through an exhausted quota', async () => {
    const before = await rejectedCount('quota');
    const { service, findCompletedReplay } = replayService(true);
    const { guard } = guardFor({ stage: 'quota', quota: 5 }, service);
    const request = requestFor('writing.task1.grade', 'completed-writing');

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(findCompletedReplay).toHaveBeenCalledWith({
      organizationId: 'org_acme',
      operation: 'writing.task1.grade',
      actorId: 'user_acme',
      idempotencyKey: 'completed-writing',
      requestBody: WRITING_BODY,
    });
    expect(
      takeCompletedReplay(request, 'writing.task1.grade', 'completed-writing'),
    ).toMatchObject({ responseStatus: 200 });
    expect(await rejectedCount('quota')).toBe(before);
    expect(getMeteringEvidence(request)).toEqual(
      expect.objectContaining({ quotaTracked: true }),
    );
  });

  it('keeps a new key, a body mismatch, or an unavailable lookup behind an exhausted quota', async () => {
    const { service } = replayService(false);
    const { guard } = guardFor({ stage: 'quota', quota: 5 }, service);

    await expect(
      guard.canActivate(
        contextFor(requestFor('writing.task1.grade', 'not-a-replay')),
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', httpStatus: 429 });

    const failing = {
      findCompletedReplay: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as IdempotencyServicePort;
    const { guard: failingGuard } = guardFor(
      { stage: 'quota', quota: 5 },
      failing,
    );
    await expect(
      failingGuard.canActivate(
        contextFor(requestFor('writing.task1.grade', 'not-a-replay')),
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('never consults a replay when graded admission cannot verify Redis', async () => {
    const { service, findCompletedReplay } = replayService(true);
    const unavailable = new AppError({
      code: 'REDIS_UNAVAILABLE',
      message: 'Quota could not be verified',
      retryable: true,
      retryAfterMs: 1_000,
    });
    const guard = new GradedAdmissionGuard(
      {
        consume: async () => {
          throw unavailable;
        },
      },
      service,
      now,
    );

    await expect(
      guard.canActivate(
        contextFor(requestFor('writing.task1.grade', 'completed-writing')),
      ),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryAfterMs: 1_000,
    });
    expect(findCompletedReplay).not.toHaveBeenCalled();
  });

  it.each([
    ['a limited production key', authenticated, true],
    [
      'an unlimited production key',
      { ...authenticated, monthlyRequestQuota: null },
      false,
    ],
    [
      'a sandbox key',
      { ...authenticated, environment: 'sandbox' as const },
      false,
    ],
  ])('marks quota tracking for %s', async (_label, key, tracked) => {
    const { guard } = guardFor({ stage: 'admitted' });
    const request = requestFor('writing.task1.grade', undefined, key);

    await guard.canActivate(contextFor(request));

    expect(getMeteringEvidence(request)).toEqual(
      expect.objectContaining({ quotaTracked: tracked }),
    );
  });

  it('records an admission whose quota counter could not be rebuilt as unverified', async () => {
    const { guard } = guardFor({ stage: 'admitted', quotaUnverified: true });
    const request = requestFor();

    await guard.canActivate(contextFor(request));

    expect(getMeteringEvidence(request)).toEqual(
      expect.objectContaining({ quotaUnverified: true }),
    );
  });

  it('refuses a graded route that has no metering evidence instead of weakening the checks', async () => {
    const { guard, calls } = guardFor({ stage: 'admitted' });
    const request = requestFor();
    delete request.aihubMetering;

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      httpStatus: 500,
    });
    expect(calls).toEqual([]);
  });

  it('refuses a graded route whose template is not the operation path', async () => {
    const { guard, calls } = guardFor({ stage: 'admitted' });
    const request = requestFor();
    request.routeOptions = { url: '/v1/something/else' };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(calls).toEqual([]);
  });
});
