import {
  SPEAKING_GRADING_JOB_CREATE_OPERATION,
  idempotencyMode,
} from './idempotency-operation';

describe('idempotencyMode', () => {
  it('uses the injected retrieval operation policy', () => {
    expect(
      idempotencyMode('speaking.v2.responses.get', {
        'speaking.v2.responses.get': { idempotency: 'none' },
      }),
    ).toBe('none');
  });

  it('makes async Speaking job creation optionally idempotent', () => {
    expect(idempotencyMode(SPEAKING_GRADING_JOB_CREATE_OPERATION)).toBe(
      'optional',
    );
  });
});
