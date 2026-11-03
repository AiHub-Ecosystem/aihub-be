import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import { RETRY_BUDGET_OPERATIONS } from './admit-graded-request';
import { findCompletedWritingReplay } from './completed-writing-replay';

const replay = { responseStatus: 200, responseBody: { data: {} } };
const attempt = {
  organizationId: 'org_acme',
  operation: 'writing.task1.grade',
  idempotencyKey: 'key-1',
  actorId: 'user_acme',
  requestBody: { essay: 'A clear response.' },
} as const;

function serviceFinding(result: unknown) {
  const findCompletedReplay = jest.fn().mockResolvedValue(result);
  return {
    service: { findCompletedReplay } as unknown as IdempotencyServicePort,
    findCompletedReplay,
  };
}

describe('findCompletedWritingReplay', () => {
  it.each(RETRY_BUDGET_OPERATIONS)(
    'looks up %s with the complete replay identity and validated body',
    async (operation) => {
      const { service, findCompletedReplay } = serviceFinding(replay);
      await expect(
        findCompletedWritingReplay(service, { ...attempt, operation }),
      ).resolves.toEqual(replay);
      expect(findCompletedReplay).toHaveBeenCalledWith({
        organizationId: 'org_acme',
        operation,
        actorId: 'user_acme',
        idempotencyKey: 'key-1',
        requestBody: attempt.requestBody,
      });
    },
  );

  it('does not query for unsupported operations or a missing key', async () => {
    const { service, findCompletedReplay } = serviceFinding(replay);
    await expect(
      findCompletedWritingReplay(service, {
        ...attempt,
        operation: 'speaking.grading',
      }),
    ).resolves.toBeUndefined();
    await expect(
      findCompletedWritingReplay(service, {
        ...attempt,
        idempotencyKey: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(findCompletedReplay).not.toHaveBeenCalled();
  });

  it('treats a lookup failure as no confirmed replay', async () => {
    const service = {
      findCompletedReplay: jest.fn().mockRejectedValue(new Error('store')),
    } as unknown as IdempotencyServicePort;
    await expect(
      findCompletedWritingReplay(service, attempt),
    ).resolves.toBeUndefined();
  });
});
