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
    expect(normalizeEmail('  Example@Example.COM ')).toBe(
      'example@example.com',
    );
    expect(normalizeUsername('  Alice._-01 ')).toBe('alice._-01');
    expect(normalizeEmail('first.last+tag@gmail.com')).toBe(
      'first.last+tag@gmail.com',
    );
  });

  it.each([
    'person@example.co.uk',
    "o'brien+tag@example.com",
    'a@xn--vd-ola.vn',
    `${'a'.repeat(64)}@example.com`,
  ])('accepts the deliverable address %j', (email) => {
    expect(normalizeEmail(email)).toBe(email);
  });

  describe('one address has one form (#394)', () => {
    it.each([
      [
        'a Unicode domain and its punycode form',
        'user@bücher.de',
        'user@xn--bcher-kva.de',
      ],
      [
        'an upper-case Unicode domain',
        'user@BÜCHER.de',
        'user@xn--bcher-kva.de',
      ],
      [
        'a decomposed Unicode domain',
        'user@bu\u0308cher.de',
        'user@xn--bcher-kva.de',
      ],
      [
        'a fullwidth ASCII domain',
        'user@ｅｘａｍｐｌｅ.com',
        'user@example.com',
      ],
      ['a Vietnamese domain', 'user@ví-dụ.vn', 'user@xn--v-d-rma6749a.vn'],
      [
        'a Japanese domain mixing Han and kana',
        'user@例え.jp',
        'user@xn--r8jz45g.jp',
      ],
    ])('maps %s to one canonical address', (_label, email, canonical) => {
      expect(normalizeEmail(email)).toBe(canonical);
    });

    it('gives the Unicode and punycode spellings of one mailbox the same form', () => {
      expect(normalizeEmail('user@bücher.de')).toBe(
        normalizeEmail('USER@XN--BCHER-KVA.DE'),
      );
    });

    it.each([
      ['a Cyrillic letter inside a Latin domain label', 'user@аpple.com'],
      [
        'a Cyrillic letter inside a Latin label given as punycode',
        'user@xn--pple-43d.com',
      ],
      ['a Greek letter inside a Latin domain label', 'user@exαmple.com'],
      ['a Latin letter inside a Han label', 'user@例a.jp'],
      ['a non-ASCII local part', 'người@example.com'],
      ['a Cyrillic local part', 'аdmin@example.com'],
      ['a punycode label that does not decode', 'user@xn--a.com'],
      ['a numeric top-level domain', 'user@example.123'],
      ['an IPv4 address in hexadecimal form', 'user@0x7f.1'],
      ['a dotted IPv4 address', 'user@1.2.3.4'],
      ['a space in the local part', 'us er@example.com'],
      ['a quote in the local part', 'us"er@example.com'],
      [
        'a label with hyphens in the third and fourth places',
        'user@ab--cd.com',
      ],
      [
        'a punycode label that decodes to a leading hyphen',
        'user@xn---bcher-kva.de',
      ],
      ['a percent escape in the domain', 'user@ex%41mple.com'],
      ['a one-letter top-level domain', 'user@example.c'],
      ['a top-level domain mixing letters and digits', 'user@example.c1'],
      ['an emoji domain', 'user@😀.com'],
      [
        'a slash left over a Latin letter in the domain',
        'user@example.co\u0338m',
      ],
      ['a slash in the domain', 'user@example.com/path'],
      ['an ideographic full stop between labels', 'user@example\u3002com'],
    ])('refuses %s', (_label, email) => {
      expect(() => normalizeEmail(email)).toThrow(LocalAuthValidationError);
    });

    it.each(['user@аpple.com', 'người@example.com', 'user@1.2.3.4'])(
      'refuses %s with the one validation error, which names no account',
      (email) => {
        expect(() => normalizeEmail(email)).toThrow(
          new LocalAuthValidationError(),
        );
      },
    );
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
