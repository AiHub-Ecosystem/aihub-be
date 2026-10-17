import argon2 from 'argon2';

import {
  ARGON2ID_DUMMY_HASH,
  ARGON2ID_ENCODED_PREFIX,
  ARGON2ID_PARAMETERS,
} from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { Argon2PasswordHasher } from './argon2-password.hasher';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('writes hashes at the owned factor and verifies them through the production path', async () => {
    const password = 'correct horse battery staple';
    const hash = await hasher.hash(password);

    expect(hash.startsWith(ARGON2ID_ENCODED_PREFIX)).toBe(true);
    await expect(hasher.verify(password, hash)).resolves.toBe(true);
  });

  it('keeps the dummy hash at the same work factor as real hashes', () => {
    expect(argon2.needsRehash(ARGON2ID_DUMMY_HASH, ARGON2ID_PARAMETERS)).toBe(
      false,
    );
  });

  // A dummy hash that no passphrase opens still has to be a real hash: garbage
  // in that position would fail before doing the work, which is the leak.
  it('spends the owned work factor verifying the dummy and rejects the password', async () => {
    await expect(
      hasher.verify('correct horse battery staple', ARGON2ID_DUMMY_HASH),
    ).resolves.toBe(false);
  });
});
