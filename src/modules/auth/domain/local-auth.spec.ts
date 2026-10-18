import {
  LocalAuthValidationError,
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
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

  it.each([
    'person@example.co.uk',
    "o'brien+tag@example.com",
    'người@ví-dụ.vn',
    'a@xn--vd-ola.vn',
    `${'a'.repeat(64)}@example.com`,
  ])('accepts the deliverable address %j', (email) => {
    expect(normalizeEmail(email)).toBe(email);
  });

  it.each([
    ['no local part', '@example.com'],
    ['no domain dot', 'person@localhost'],
    ['a trailing domain dot', 'person@example.com.'],
    ['an empty label', 'person@example..com'],
    ['a label edged by a hyphen', 'person@-example.com'],
    ['an underscore in the domain', 'person@ex_ample.com'],
    ['a second at sign', 'a@b@example.com'],
    ['a leading local dot', '.person@example.com'],
    ['a trailing local dot', 'person.@example.com'],
    ['consecutive local dots', 'per..son@example.com'],
    ['a zero-width space', 'per\u200Bson@example.com'],
    ['a directional override', 'person\u202E@example.com'],
    ['a control character', 'per\u0007son@example.com'],
    ['a 65-byte local part', `${'a'.repeat(65)}@example.com`],
    ['a 64-character label', `person@${'a'.repeat(64)}.com`],
    [
      'a path over 254 bytes',
      `person@${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(61)}.com`,
    ],
  ])('refuses an address with %s', (_label, email) => {
    expect(() => normalizeEmail(email)).toThrow(LocalAuthValidationError);
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
});
