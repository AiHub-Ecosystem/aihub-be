import { Argon2PasswordHasher } from './argon2-password.hasher';

describe('Argon2PasswordHasher', () => {
  it('uses Argon2id with the agreed work factor and verifies exact passwords', async () => {
    const hasher = new Argon2PasswordHasher();
    const password = '  exact Unicode password é  ';
    const encoded = await hasher.hash(password);

    // The native library is free to order the cost parameters; the agreed
    // parameters are what this test pins.
    expect(encoded).toMatch(/^\$argon2id\$v=19\$/);
    expect(encoded).toMatch(/m=65536/);
    expect(encoded).toMatch(/t=3/);
    expect(encoded).toMatch(/p=1/);
    await expect(hasher.verify(password, encoded)).resolves.toBe(true);
    await expect(hasher.verify(password.trim(), encoded)).resolves.toBe(false);
    await expect(hasher.verify('wrong password', encoded)).resolves.toBe(false);
  }, 15_000);

  it('fails closed for malformed encoded hashes', async () => {
    await expect(
      new Argon2PasswordHasher().verify('password', 'not-a-phc-hash'),
    ).resolves.toBe(false);
  });
});
