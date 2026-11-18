import { invalidIdentityData } from './identity-row';

describe('invalidIdentityData', () => {
  it('keeps the code, message and retryability of the legacy construction', () => {
    const error = invalidIdentityData();

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Identity data is invalid');
    expect(error.retryable).toBe(false);
  });
});
