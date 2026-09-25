import {
  LocalAuthValidationError,
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  canTransitionToActive,
  normalizeEmail,
  normalizeRegistration,
  normalizeUsername,
  validatePassword,
} from './local-auth';

describe('local auth domain', () => {
  it('canonicalizes email and username without provider-specific folding', () => {
    expect(normalizeEmail('  E\u0301xample@Example.COM ')).toBe(
      'éxample@example.com',
    );
    expect(normalizeUsername('  Alice._-01 ')).toBe('alice._-01');
    expect(normalizeEmail('first.last+tag@gmail.com')).toBe(
      'first.last+tag@gmail.com',
    );
  });

  it('exposes the agreed password policy bounds', () => {
    expect([PASSWORD_MIN_CODE_POINTS, PASSWORD_MAX_CODE_POINTS]).toEqual([
      12, 128,
    ]);
  });

  it.each([12, 128])('accepts %i ASCII code points', (length) => {
    const password = 'a'.repeat(length);
    expect(validatePassword(password)).toBe(password);
  });

  it.each([11, 129])('rejects %i ASCII code points', (length) => {
    expect(() => validatePassword('a'.repeat(length))).toThrow(
      LocalAuthValidationError,
    );
  });

  it.each([12, 128])('accepts %i astral code points', (length) => {
    const password = '😀'.repeat(length);
    expect(validatePassword(password)).toBe(password);
  });

  it.each([11, 129])('rejects %i astral code points', (length) => {
    expect(() => validatePassword('😀'.repeat(length))).toThrow(
      LocalAuthValidationError,
    );
  });

  it('counts combining code points without normalizing the password', () => {
    const password = `${'a'.repeat(10)}e\u0301`;
    expect(validatePassword(password)).toBe(password);
  });

  it('normalizes registration as one boundary operation', () => {
    expect(
      normalizeRegistration({
        email: '  PERSON@example.com',
        username: ' User_01 ',
        password: 'correct horse battery',
      }),
    ).toEqual({
      email: 'person@example.com',
      username: 'user_01',
      password: 'correct horse battery',
    });
  });

  it('only permits pending accounts to become active', () => {
    expect(canTransitionToActive('pending_verification')).toBe(true);
    expect(canTransitionToActive('active')).toBe(false);
    expect(canTransitionToActive('disabled')).toBe(false);
  });
});
