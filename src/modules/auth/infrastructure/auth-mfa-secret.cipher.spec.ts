import { AuthMfaCipher, createAuthMfaCipher } from './auth-mfa-secret.cipher';

const key = Buffer.alloc(32, 9).toString('base64');

describe('AuthMfaCipher', () => {
  it('encrypts secrets with AES-GCM and rejects tampering', () => {
    const cipher = new AuthMfaCipher({
      currentKeyId: 'test-key',
      keys: { 'test-key': key },
    });
    const binding = { userId: 'usr_test', factorId: 'mfa_test' };
    const encrypted = cipher.encrypt('totp-secret', binding);

    expect(encrypted.ciphertext).not.toContain('totp-secret');
    expect(cipher.decrypt(encrypted.keyId, encrypted.ciphertext, binding)).toBe(
      'totp-secret',
    );
    expect(() =>
      cipher.decrypt(encrypted.keyId, `${encrypted.ciphertext}x`, binding),
    ).toThrow('Auth MFA ciphertext is invalid');
    expect(() =>
      cipher.decrypt(encrypted.keyId, encrypted.ciphertext, {
        ...binding,
        userId: 'usr_other',
      }),
    ).toThrow('Auth MFA ciphertext is invalid');
  });

  it('loads only the separate rendered key bundle and validates key size', () => {
    const cipher = createAuthMfaCipher({
      source: 'agent-file',
      secretsFile: 'auth-mfa-secrets.json',
      values: {},
      readFile: (path) => {
        expect(path).toBe('auth-mfa-secrets.json');
        return JSON.stringify({
          current_key_id: 'test-key',
          keys: { 'test-key': key },
        });
      },
    });
    const binding = { userId: 'usr_test', factorId: 'mfa_test' };
    const encrypted = cipher.encrypt('secret', binding);
    expect(cipher.decrypt(encrypted.keyId, encrypted.ciphertext, binding)).toBe(
      'secret',
    );
    expect(
      () =>
        new AuthMfaCipher({
          currentKeyId: 'bad-key',
          keys: { 'bad-key': Buffer.alloc(16).toString('base64') },
        }),
    ).toThrow('Auth MFA keyring is invalid');
  });
});
