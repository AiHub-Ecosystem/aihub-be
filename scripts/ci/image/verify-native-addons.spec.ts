import { readFileSync } from 'node:fs';

import {
  runNativeAddonProbes,
  verifyArgon2,
  verifySharp,
} from './verify-native-addons.cjs';

describe('native addons verification in image boot check (#1482)', () => {
  it('successfully executes argon2 and sharp probes with prebuilt binaries', async () => {
    await expect(verifyArgon2()).resolves.toBeUndefined();
    await expect(verifySharp()).resolves.toBeUndefined();
    await expect(runNativeAddonProbes()).resolves.toBeUndefined();
  });

  it('fails with an explicit diagnostic naming argon2 if argon2 hashing fails', async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const failingHasher = {
      hash: (_password: string) =>
        Promise.reject(new Error('incompatible binding ELF')),
    };

    try {
      await expect(verifyArgon2(failingHasher)).rejects.toThrow(
        /native addon probe failed for argon2/,
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[native-probe] failed to load or execute native module: argon2',
        ),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('fails with an explicit diagnostic naming sharp if sharp processing fails', async () => {
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const failingSharp = (_input: unknown) => {
      throw new Error('libvips missing');
    };

    try {
      await expect(verifySharp(failingSharp)).rejects.toThrow(
        /native addon probe failed for sharp/,
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[native-probe] failed to load or execute native module: sharp',
        ),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('invokes verify-native-addons.cjs inside the running container in image-boot-check.sh', () => {
    const script = readFileSync('scripts/ci/image/image-boot-check.sh', 'utf8');
    expect(script).toContain('verify-native-addons.cjs');
    expect(script).toContain('docker exec -i "$container" node - <');
  });

  it('documents native addons verification in docs/operations/ci-boot-check.md', () => {
    const doc = readFileSync('docs/operations/ci-boot-check.md', 'utf8');
    expect(doc).toContain('argon2');
    expect(doc).toContain('sharp');
  });
});
