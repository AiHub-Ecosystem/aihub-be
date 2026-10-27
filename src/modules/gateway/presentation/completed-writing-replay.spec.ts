import { RETRY_BUDGET_OPERATIONS } from '@/modules/gateway/application/admit-graded-request';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { findCompletedWritingReplay } from './completed-writing-replay';

const TASK1_BODY = {
  question: 'Describe the chart.',
  chart_type: 'Bar Chart',
  essay: 'The chart shows a clear trend.',
  image_url: 'https://example.com/chart.png',
};

const TASK2_BODY = {
  question: 'Some people prefer to live in cities.',
  topic: 'urbanisation',
  essay: 'Cities offer more jobs and services.',
};

const BODIES = {
  'writing.task1.grade': TASK1_BODY,
  'writing.task2.grade': TASK2_BODY,
} as const;

const stored = {
  responseStatus: 200,
  responseBody: { operation: 'writing.task1.grade', data: {} },
};

function requestWith(
  overrides: Record<string, unknown> = {},
): AuthenticatedRequest {
  return {
    id: 'req_replay',
    raw: {},
    headers: {},
    body: TASK1_BODY,
    aihubIdentity: { mode: 'declared_id', userId: 'user_acme' },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function serviceFinding(replay: unknown): {
  readonly service: IdempotencyServicePort;
  readonly findCompletedReplay: jest.Mock;
} {
  const findCompletedReplay = jest.fn().mockResolvedValue(replay);
  return {
    findCompletedReplay,
    service: { findCompletedReplay } as unknown as IdempotencyServicePort,
  };
}

const attempt = {
  organizationId: 'org_acme',
  operation: 'writing.task1.grade',
  idempotencyKey: 'key-1',
} as const;

describe('findCompletedWritingReplay', () => {
  it.each(RETRY_BUDGET_OPERATIONS)(
    'confirms a stored replay for %s with the caller, key, and body',
    async (operation) => {
      const { service, findCompletedReplay } = serviceFinding(stored);

      await expect(
        findCompletedWritingReplay(
          requestWith({ body: BODIES[operation] }),
          service,
          {
            ...attempt,
            operation,
          },
        ),
      ).resolves.toEqual({
        operation,
        idempotencyKey: 'key-1',
        replay: stored,
      });
      expect(findCompletedReplay).toHaveBeenCalledWith({
        organizationId: 'org_acme',
        operation,
        actorId: 'user_acme',
        idempotencyKey: 'key-1',
        requestBody: BODIES[operation],
      });
    },
  );

  it('answers undefined when nothing durable matches', async () => {
    const { service } = serviceFinding(undefined);

    await expect(
      findCompletedWritingReplay(requestWith(), service, attempt),
    ).resolves.toBeUndefined();
  });

  it('answers undefined, without a lookup, for an operation that has no replay', async () => {
    const { service, findCompletedReplay } = serviceFinding(stored);

    await expect(
      findCompletedWritingReplay(requestWith(), service, {
        ...attempt,
        operation: 'speaking.grading',
      }),
    ).resolves.toBeUndefined();
    expect(findCompletedReplay).not.toHaveBeenCalled();
  });

  it.each([
    ['no idempotency service', undefined, requestWith(), attempt],
    [
      'no key',
      serviceFinding(stored).service,
      requestWith(),
      { ...attempt, idempotencyKey: undefined },
    ],
    [
      'no identified user',
      serviceFinding(stored).service,
      requestWith({ aihubIdentity: undefined }),
      attempt,
    ],
  ])('answers undefined with %s', async (_name, service, request, input) => {
    await expect(
      findCompletedWritingReplay(request, service, input),
    ).resolves.toBeUndefined();
  });

  it('answers undefined for a body the operation would not accept', async () => {
    const { service, findCompletedReplay } = serviceFinding(stored);

    await expect(
      findCompletedWritingReplay(requestWith({ body: { essay: 1 } }), service, {
        ...attempt,
      }),
    ).resolves.toBeUndefined();
    expect(findCompletedReplay).not.toHaveBeenCalled();
  });

  it('answers undefined when the replay lookup fails', async () => {
    const findCompletedReplay = jest.fn().mockRejectedValue(new Error('db'));
    const service = {
      findCompletedReplay,
    } as unknown as IdempotencyServicePort;

    await expect(
      findCompletedWritingReplay(requestWith(), service, attempt),
    ).resolves.toBeUndefined();
  });
});
