const process = require('node:process');

/**
 * @typedef {{
 *   png: () => { toBuffer: () => Promise<Buffer> };
 *   metadata: () => Promise<{ format?: string; width?: number; height?: number }>;
 * }} SharpPipeline
 * @typedef {(input: unknown) => SharpPipeline} SharpFactory
 * @typedef {{ hash: (password: string) => Promise<string> }} Argon2Hasher
 */

/**
 * Verify argon2 native binding by computing a password hash.
 * @param {Argon2Hasher} [hasher]
 */
async function verifyArgon2(hasher = require('argon2')) {
  try {
    const hash = await hasher.hash('aihub-boot-probe');
    if (!hash || typeof hash !== 'string' || !hash.startsWith('$argon2')) {
      throw new Error('argon2.hash returned invalid hash format');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[native-probe] failed to load or execute native module: argon2\n${message}\n`,
    );
    throw new Error(`native addon probe failed for argon2: ${message}`);
  }
}

/**
 * Verify sharp native binding by generating a 1x1 buffer and reading metadata.
 * @param {SharpFactory} [sharpFactory]
 */
async function verifySharp(sharpFactory = require('sharp')) {
  try {
    const probeBuffer = await sharpFactory({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const metadata = await sharpFactory(probeBuffer).metadata();
    if (
      metadata.format !== 'png' ||
      metadata.width !== 1 ||
      metadata.height !== 1
    ) {
      throw new Error(
        'sharp metadata returned unexpected format or dimensions',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[native-probe] failed to load or execute native module: sharp\n${message}\n`,
    );
    throw new Error(`native addon probe failed for sharp: ${message}`);
  }
}

async function runNativeAddonProbes(
  hasher = require('argon2'),
  sharpFactory = require('sharp'),
) {
  await verifyArgon2(hasher);
  await verifySharp(sharpFactory);
  process.stdout.write('native addons verified: argon2, sharp\n');
}

if (require.main === module) {
  runNativeAddonProbes().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

module.exports = {
  verifyArgon2,
  verifySharp,
  runNativeAddonProbes,
};
