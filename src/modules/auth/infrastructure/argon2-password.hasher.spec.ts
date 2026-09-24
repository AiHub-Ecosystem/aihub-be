import { Argon2PasswordHasher } from './argon2-password.hasher';

describe('Argon2PasswordHasher', () => {
  it('uses Argon2id with the agreed work factor and verifies exact passwords', async () => {
    const hasher = new Argon2PasswordHasher();
    const password = '  exact Unicode password é  ';
    const encoded = await hasher.hash(password);

    expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
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
