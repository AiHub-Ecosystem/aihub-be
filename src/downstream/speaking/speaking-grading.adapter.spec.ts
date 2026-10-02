import { createRequestContext } from '@/common/request-context/request-context.factory';
import { requiredSpeakingUserId } from './speaking-grading.adapter';

function context(userId?: string) {
  return createRequestContext({
    requestId: 'req_01M2MNRPCGCT96P54KDBE82MH7',
    receivedAt: new Date(),
    deadlineMs: 5_000,
    organizationId: 'org_acme',
    ...(userId === undefined ? {} : { userId }),
    scopes: [],
  });
}

describe('requiredSpeakingUserId', () => {
  it('returns the End-User ID exactly as resolved', () => {
    expect(requiredSpeakingUserId(context('Student@Example.COM'))).toBe(
      'Student@Example.COM',
    );
  });

  it.each([
    ['missing', undefined],
    ['blank', '  '],
  ])(
    'rejects a %s End-User ID before a downstream request exists',
    (_name, userId) => {
      expect(() => requiredSpeakingUserId(context(userId))).toThrow(
        expect.objectContaining({ code: 'USER_IDENTITY_REQUIRED' }),
      );
    },
  );
});
