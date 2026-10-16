import sharp from 'sharp';

import type { WritingChartContentType } from '@/modules/writing/domain/writing-chart-upload';
import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_MAX_PIXELS,
} from './writing-chart-upload.policy';

const FORMAT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const satisfies Record<WritingChartContentType, 'jpeg' | 'png' | 'webp'>;

sharp.concurrency(1);

function withinPixelLimit(
  width: number | undefined,
  height: number | undefined,
) {
  return (
    width !== undefined &&
    height !== undefined &&
    width > 0 &&
    height > 0 &&
    width * height <= WRITING_CHART_MAX_PIXELS
  );
}

function hasCompleteContainer(
  contentType: WritingChartContentType,
  bytes: Uint8Array,
): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (contentType === 'image/jpeg') {
    return (
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    );
  }
  if (contentType === 'image/webp') {
    return (
      bytes.byteLength >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP' &&
      buffer.readUInt32LE(4) + 8 <= bytes.byteLength
    );
  }

  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return false;
    if (
      bytes[offset + 4] === 0x49 &&
      bytes[offset + 5] === 0x45 &&
      bytes[offset + 6] === 0x4e &&
      bytes[offset + 7] === 0x44
    ) {
      return length === 0;
    }
    offset = end;
  }
  return false;
}

export async function sanitizeWritingChartImage(input: {
  readonly contentType: WritingChartContentType;
  readonly bytes: Uint8Array;
}): Promise<Buffer | undefined> {
  if (
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > WRITING_CHART_MAX_BYTES ||
    !hasCompleteContainer(input.contentType, input.bytes)
  ) {
    return undefined;
  }

  const source = Buffer.from(
    input.bytes.buffer,
    input.bytes.byteOffset,
    input.bytes.byteLength,
  );
  const expectedFormat = FORMAT_BY_CONTENT_TYPE[input.contentType];
  const inputOptions = {
    failOn: 'warning' as const,
    limitInputPixels: WRITING_CHART_MAX_PIXELS,
    sequentialRead: true,
  };

  try {
    const metadata = await sharp(source, {
      ...inputOptions,
      animated: true,
    }).metadata();
    if (
      metadata.format !== expectedFormat ||
      (metadata.pages ?? 1) !== 1 ||
      !withinPixelLimit(metadata.width, metadata.height)
    ) {
      return undefined;
    }

    const output = sharp(source, inputOptions).rotate();
    if (input.contentType === 'image/jpeg') {
      output.jpeg({ quality: 100, chromaSubsampling: '4:4:4' });
    } else if (input.contentType === 'image/png') {
      output.png();
    } else {
      output.webp({ lossless: true });
    }

    const { data, info } = await output.toBuffer({ resolveWithObject: true });
    if (
      data.byteLength > WRITING_CHART_MAX_BYTES ||
      info.format !== expectedFormat ||
      (info.pages ?? 1) !== 1 ||
      !withinPixelLimit(info.width, info.height)
    ) {
      return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}
