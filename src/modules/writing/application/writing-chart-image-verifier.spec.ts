import sharp from 'sharp';

import { getMetrics } from '@/common/observability/metrics';
import { sanitizeWritingChartImage } from './writing-chart-image-verifier';
import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_MAX_PIXELS,
} from './writing-chart-upload.policy';

async function image(format: 'jpeg' | 'png' | 'webp', width = 2, height = 2) {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 80, g: 120, b: 160 },
    },
  });
  return pipeline[format]().toBuffer();
}

function webpChunk(name: string, bytes: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.write(name, 0, 'ascii');
  header.writeUInt32LE(bytes.byteLength, 4);
  return Buffer.concat([
    header,
    Buffer.from(bytes),
    ...(bytes.byteLength % 2 === 0 ? [] : [Buffer.alloc(1)]),
  ]);
}

function animatedWebp(still: Uint8Array): Buffer {
  let offset = 12;
  let frame: Buffer | undefined;
  while (offset + 8 <= still.byteLength) {
    const name = Buffer.from(still).toString('ascii', offset, offset + 4);
    const size = Buffer.from(still).readUInt32LE(offset + 4);
    if (name === 'VP8L' || name === 'VP8 ') {
      frame = webpChunk(name, still.subarray(offset + 8, offset + 8 + size));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (frame === undefined) throw new Error('Missing WebP frame');

  const extendedHeader = Buffer.alloc(10);
  extendedHeader[0] = 0x02;
  const animation = Buffer.alloc(6);
  const frameHeader = Buffer.alloc(16);
  frameHeader[6] = 0;
  frameHeader[9] = 0;
  const frameData = webpChunk('ANMF', Buffer.concat([frameHeader, frame]));
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    webpChunk('VP8X', extendedHeader),
    webpChunk('ANIM', animation),
    frameData,
    frameData,
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.byteLength, 4);
  return Buffer.concat([riff, body]);
}

describe('sanitizeWritingChartImage', () => {
  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const)(
    're-encodes a valid %s image as %s',
    async (contentType, format) => {
      const source = await image(format);
      const sanitized = await sanitizeWritingChartImage({
        contentType,
        bytes: source,
      });

      expect(sanitized).toMatchObject({ kind: 'sanitized' });
      if (sanitized?.kind !== 'sanitized')
        throw new Error('Image not sanitized');
      await expect(sharp(sanitized.bytes).metadata()).resolves.toMatchObject({
        format,
        width: 2,
        height: 2,
      });
    },
  );

  it('rejects mismatched, truncated, oversized, and multi-frame images', async () => {
    const png = await image('png');
    const oversized = await image(
      'png',
      Math.ceil(Math.sqrt(WRITING_CHART_MAX_PIXELS)) + 1,
      Math.ceil(Math.sqrt(WRITING_CHART_MAX_PIXELS)) + 1,
    );
    const webp = await image('webp');

    await expect(
      sanitizeWritingChartImage({ contentType: 'image/jpeg', bytes: png }),
    ).resolves.toBeUndefined();
    await expect(
      sanitizeWritingChartImage({
        contentType: 'image/png',
        bytes: png.subarray(0, png.byteLength - 8),
      }),
    ).resolves.toBeUndefined();
    const jpeg = await image('jpeg');
    await expect(
      sanitizeWritingChartImage({
        contentType: 'image/jpeg',
        bytes: jpeg.subarray(0, jpeg.byteLength - 2),
      }),
    ).resolves.toBeUndefined();
    await expect(
      sanitizeWritingChartImage({ contentType: 'image/png', bytes: oversized }),
    ).resolves.toBeUndefined();
    await expect(
      sanitizeWritingChartImage({
        contentType: 'image/webp',
        bytes: animatedWebp(webp),
      }),
    ).resolves.toBeUndefined();
    await expect(
      sanitizeWritingChartImage({
        contentType: 'image/png',
        bytes: Buffer.alloc(WRITING_CHART_MAX_BYTES + 1),
      }),
    ).resolves.toBeUndefined();
  });

  it('drops EXIF and ICC metadata from JPEG images', async () => {
    const withMetadata = await sharp(await image('jpeg'))
      .withExif({ IFD0: { Make: 'private-camera', Model: 'private-model' } })
      .withIccProfile('srgb')
      .jpeg()
      .toBuffer();
    const sanitized = await sanitizeWritingChartImage({
      contentType: 'image/jpeg',
      bytes: withMetadata,
    });

    expect(sanitized).toMatchObject({ kind: 'sanitized' });
    if (sanitized?.kind !== 'sanitized') throw new Error('Image not sanitized');
    const metadata = await sharp(sanitized.bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it('drops trailing bytes outside a complete PNG container', async () => {
    const source = await image('png');
    const uploaded = Buffer.concat([source, Buffer.from([0xde, 0xad])]);
    const sanitized = await sanitizeWritingChartImage({
      contentType: 'image/png',
      bytes: uploaded,
    });

    expect(sanitized).toMatchObject({ kind: 'sanitized' });
    expect(
      sanitized?.kind === 'sanitized' &&
        sanitized.bytes.subarray(-2).equals(Buffer.from([0xde, 0xad])),
    ).toBe(false);
  });

  it('keeps the event loop responsive for a 20-megapixel image', async () => {
    const source = await image('jpeg', 5_000, 4_000);
    await getMetrics();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await getMetrics();

    const sanitized = await sanitizeWritingChartImage({
      contentType: 'image/jpeg',
      bytes: source,
    });
    expect(sanitized).toMatchObject({ kind: 'sanitized' });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const metrics = await getMetrics();
    const lag = metrics.match(/^aihub_event_loop_lag_seconds (\S+)$/m);
    expect(lag).not.toBeNull();
    expect(Number(lag?.[1])).toBeLessThan(0.1);
  });
});
