import argon2 from 'argon2';

import { AppError } from '@/common/errors/app-error';
import {
  ARGON2ID_DUMMY_HASH,
  ARGON2ID_ENCODED_PREFIX,
  ARGON2ID_PARAMETERS,
} from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { Argon2PasswordHasher } from './argon2-password.hasher';

describe('Argon2PasswordHasher', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

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

  it('limits hash and verify operations together', async () => {
    let active = 0;
    let peak = 0;
    const work = async <T>(result: T) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return result;
    };
    jest.spyOn(argon2, 'hash').mockImplementation(() => work('hash'));
    jest.spyOn(argon2, 'verify').mockImplementation(() => work(true));

    const cappedHasher = new Argon2PasswordHasher();
    const operations = [
      cappedHasher.hash('one'),
      cappedHasher.verify('password', 'encoded'),
      cappedHasher.hash('three'),
      cappedHasher.verify('password', 'encoded'),
    ];

    await Promise.all(operations);

    expect(peak).toBe(2);
  });

  it('bounds queued work and refuses excess work with retry guidance', async () => {
    jest.useFakeTimers();
    const releases: Array<() => void> = [];
    const work = <T>(result: T) =>
      new Promise<T>((resolve) => releases.push(() => resolve(result)));
    jest.spyOn(argon2, 'hash').mockImplementation(() => work('hash'));
    jest.spyOn(argon2, 'verify').mockImplementation(() => work(true));

    const cappedHasher = new Argon2PasswordHasher();
    const active = [cappedHasher.hash('one'), cappedHasher.hash('two')];
    const queued = Array.from({ length: 8 }, (_, index) =>
      cappedHasher.verify('password', `encoded-${index}`).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    await Promise.resolve();
    expect(releases).toHaveLength(2);

    await expect(
      cappedHasher.verify('password', 'overflow'),
    ).rejects.toMatchObject({
      code: 'AUTH_ARGON2_CAPACITY',
      httpStatus: 503,
      retryable: true,
      retryAfterMs: 1000,
    });
    await jest.advanceTimersByTimeAsync(1001);
    expect(
      (await Promise.all(queued)).every((error) => error instanceof AppError),
    ).toBe(true);

    for (const release of releases) release();
    await Promise.all(active);
    jest.useRealTimers();
  });
});
