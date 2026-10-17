import {
  generateMfaRecoveryCodes,
  generateTotpSecret,
  hashMfaRecoveryCode,
  verifyTotp,
} from './mfa-policy';

describe('MFA policy', () => {
  it('accepts the current TOTP and one adjacent time step only', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = new Date(59_000);
    expect(verifyTotp(secret, '287082', now)).toBe(true);
    expect(verifyTotp(secret, '287082', new Date(89_000))).toBe(true);
    expect(verifyTotp(secret, '287082', new Date(119_000))).toBe(false);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/u);
  });

  it.each([' 287082', '287082 ', '0287082', '28708'])(
    'refuses %j, which is not exactly six digits',
    (code) => {
      expect(
        verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', code, new Date(59_000)),
      ).toBe(false);
    },
  );

  it('fails loudly on a stored secret that is not base32 rather than answering false', () => {
    expect(() =>
      verifyTotp('gezdgnbv-not-base32', '287082', new Date(59_000)),
    ).toThrow('TOTP secret is invalid');
  });

  it('generates independent one-time recovery code values and hashes them normalized', () => {
    const codes = generateMfaRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    expect(
      codes.every((code) => /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/u.test(code)),
    ).toBe(true);
    expect(hashMfaRecoveryCode(codes[0]!)).toBe(
      hashMfaRecoveryCode(codes[0]!.replaceAll('-', '').toLowerCase()),
    );
    expect(hashMfaRecoveryCode('not-a-recovery-code')).not.toBe(
      hashMfaRecoveryCode(codes[0]!),
    );
  });
});
