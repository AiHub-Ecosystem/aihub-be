import { constantTimeEquals } from './constant-time-equals';

describe('constantTimeEquals', () => {
  it('accepts only an exact match', () => {
    expect(constantTimeEquals('secret-value', 'secret-value')).toBe(true);
    expect(constantTimeEquals('secret-valu', 'secret-value')).toBe(false);
    expect(constantTimeEquals('secret-value ', 'secret-value')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  /**
   * The length guard is what makes the comparison safe rather than a throw: a
   * caller that sends a different-length value must get an answer, not a crash,
   * and must not learn which side was short.
   */
  it('answers a different-length value instead of throwing', () => {
    expect(constantTimeEquals('short', 'a-much-longer-secret')).toBe(false);
    expect(constantTimeEquals('a-much-longer-secret', 'short')).toBe(false);
    expect(() => constantTimeEquals('short', 'longer')).not.toThrow();
  });
});
