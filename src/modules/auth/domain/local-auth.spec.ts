import {
  LocalAuthValidationError,
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

  it('keeps password bytes/characters exact while enforcing Unicode length', () => {
    const password = '  1234567890é';
    expect(validatePassword(password)).toBe(password);
    expect(() => validatePassword('short')).toThrow(LocalAuthValidationError);
    expect(() => validatePassword('x'.repeat(129))).toThrow(
      LocalAuthValidationError,
    );
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
