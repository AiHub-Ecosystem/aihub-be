import { contractViolation } from './contract-violation';

describe('contractViolation', () => {
  it('is a non-retryable contract violation that keeps the reason for the log, not the client', () => {
    const error = contractViolation('missing data');

    expect(error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      'AI service returned an unexpected response shape',
    );
    expect(error.diagnostic).toBe('missing data');
    expect((error.cause as Error).message).toBe('missing data');
  });
});
