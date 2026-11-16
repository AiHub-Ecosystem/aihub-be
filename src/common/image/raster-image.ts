import sharp from 'sharp';

/**
 * The raster formats an uploaded image may carry. SVG is refused: it can carry
 * script, and these images are shown to other people.
 */
export type RasterImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';

type RasterImageFormat = 'jpeg' | 'png' | 'webp';

const FORMAT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const satisfies Record<RasterImageContentType, RasterImageFormat>;

sharp.concurrency(1);

let processingTail: Promise<void> = Promise.resolve();

/** Decoding is expensive, so only one image is processed at a time. */
export function serializeRasterImageProcessing<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = processingTail.then(operation, operation);
  processingTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withinPixelLimit(
  width: number | undefined,
  height: number | undefined,
  maxPixels: number,
): boolean {
  return (
    width !== undefined &&
    height !== undefined &&
    width > 0 &&
    height > 0 &&
    width * height <= maxPixels
  );
}

function hasCompleteContainer(
  contentType: RasterImageContentType,
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

/**
 * Re-encodes an uploaded image from its decoded pixels, which is what drops
 * EXIF (GPS, capture time, device model), XMP, and any ICC profile the upload
 * carried, and also any bytes trailing the container (#429).
 */
export async function sanitizeRasterImage(input: {
  readonly contentType: RasterImageContentType;
  readonly bytes: Uint8Array;
  readonly maxBytes: number;
  readonly maxPixels: number;
}): Promise<
  | { readonly kind: 'sanitized'; readonly bytes: Buffer }
  | { readonly kind: 'too_large' }
  | undefined
> {
  if (
    input.bytes.byteLength < 1 ||
    input.bytes.byteLength > input.maxBytes ||
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
    limitInputPixels: input.maxPixels,
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
      !withinPixelLimit(metadata.width, metadata.height, input.maxPixels)
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
    if (data.byteLength > input.maxBytes) {
      return { kind: 'too_large' };
    }
    if (
      info.format !== expectedFormat ||
      (info.pages ?? 1) !== 1 ||
      !withinPixelLimit(info.width, info.height, input.maxPixels)
    ) {
      return undefined;
    }
    return { kind: 'sanitized', bytes: data };
  } catch {
    return undefined;
  }
}
