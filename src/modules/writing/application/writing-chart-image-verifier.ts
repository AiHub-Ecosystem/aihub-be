import type { WritingChartContentType } from '@/modules/writing/domain/writing-chart-upload';
import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_MAX_PIXELS,
  WRITING_CHART_RANGE_BYTES,
} from './writing-chart-upload.policy';

type Dimensions = { readonly width: number; readonly height: number };

function u16be(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset, false);
}

function u24le(bytes: Uint8Array, offset: number): number | undefined {
  const low = bytes[offset];
  const middle = bytes[offset + 1];
  const high = bytes[offset + 2];
  if (low === undefined || middle === undefined || high === undefined)
    return undefined;
  return low | (middle << 8) | (high << 16);
}

function u32be(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
}

function u32le(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function dimensionsWithinLimit(dimensions: Dimensions | undefined): boolean {
  return (
    dimensions !== undefined &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    dimensions.width * dimensions.height <= WRITING_CHART_MAX_PIXELS
  );
}

function pngDimensions(
  prefix: Uint8Array,
  suffix: Uint8Array,
): Dimensions | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const width = u32be(prefix, 16);
  const height = u32be(prefix, 20);
  if (
    prefix.byteLength < 24 ||
    !signature.every((byte, index) => prefix[index] === byte) ||
    u32be(prefix, 8) !== 13 ||
    ascii(prefix, 12, 4) !== 'IHDR' ||
    suffix.byteLength < 12 ||
    u32be(suffix, suffix.byteLength - 12) !== 0 ||
    ascii(suffix, suffix.byteLength - 8, 4) !== 'IEND' ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { width, height };
}

function jpegDimensions(prefix: Uint8Array): Dimensions | undefined {
  if (prefix[0] !== 0xff || prefix[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= prefix.byteLength) {
    if (prefix[offset] !== 0xff) return undefined;
    while (prefix[offset] === 0xff) offset += 1;
    const marker = prefix[offset];
    if (marker === undefined || marker === 0xda || marker === 0xd9)
      return undefined;
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = u16be(prefix, offset);
    if (length === undefined || length < 2 || offset + length > prefix.length)
      return undefined;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 7) return undefined;
      const height = u16be(prefix, offset + 3);
      const width = u16be(prefix, offset + 5);
      return width === undefined || height === undefined
        ? undefined
        : { width, height };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(
  prefix: Uint8Array,
  byteSize: number,
): Dimensions | undefined {
  if (
    prefix.byteLength < 20 ||
    ascii(prefix, 0, 4) !== 'RIFF' ||
    u32le(prefix, 4) !== byteSize - 8 ||
    ascii(prefix, 8, 4) !== 'WEBP'
  ) {
    return undefined;
  }
  let offset = 12;
  while (offset + 8 <= prefix.byteLength) {
    const kind = ascii(prefix, offset, 4);
    const chunkSize = u32le(prefix, offset + 4);
    const data = offset + 8;
    if (chunkSize === undefined) return undefined;
    const next = data + chunkSize + (chunkSize % 2);
    if (next > byteSize) return undefined;
    if (kind === 'VP8X' && chunkSize >= 10 && data + 10 <= prefix.length) {
      const width = u24le(prefix, data + 4);
      const height = u24le(prefix, data + 7);
      return width === undefined || height === undefined
        ? undefined
        : { width: width + 1, height: height + 1 };
    }
    if (kind === 'VP8 ' && chunkSize >= 10 && data + 10 <= prefix.length) {
      const frameTag = prefix[data];
      if (
        frameTag === undefined ||
        frameTag % 2 !== 0 ||
        prefix[data + 3] !== 0x9d ||
        prefix[data + 4] !== 0x01 ||
        prefix[data + 5] !== 0x2a
      ) {
        return undefined;
      }
      const width = prefix[data + 6];
      const widthHigh = prefix[data + 7];
      const height = prefix[data + 8];
      const heightHigh = prefix[data + 9];
      return width === undefined ||
        widthHigh === undefined ||
        height === undefined ||
        heightHigh === undefined
        ? undefined
        : {
            width: (width | (widthHigh << 8)) & 0x3fff,
            height: (height | (heightHigh << 8)) & 0x3fff,
          };
    }
    if (
      kind === 'VP8L' &&
      chunkSize >= 5 &&
      data + 5 <= prefix.length &&
      prefix[data] === 0x2f
    ) {
      const b1 = prefix[data + 1];
      const b2 = prefix[data + 2];
      const b3 = prefix[data + 3];
      const b4 = prefix[data + 4];
      if (
        b1 === undefined ||
        b2 === undefined ||
        b3 === undefined ||
        b4 === undefined ||
        (b4 & 0xe0) !== 0
      ) {
        return undefined;
      }
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    if (next > prefix.byteLength) return undefined;
    offset = next;
  }
  return undefined;
}

export function verifyWritingChartImageHeaders(input: {
  readonly contentType: WritingChartContentType;
  readonly byteSize: number;
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
}): boolean {
  const expectedRangeBytes = Math.min(
    input.byteSize,
    WRITING_CHART_RANGE_BYTES,
  );
  if (
    input.byteSize < 1 ||
    input.byteSize > WRITING_CHART_MAX_BYTES ||
    input.prefix.byteLength !== expectedRangeBytes ||
    input.suffix.byteLength !== expectedRangeBytes
  ) {
    return false;
  }

  let dimensions: Dimensions | undefined;
  if (input.contentType === 'image/png') {
    dimensions = pngDimensions(input.prefix, input.suffix);
  } else if (input.contentType === 'image/jpeg') {
    if (input.suffix.at(-2) !== 0xff || input.suffix.at(-1) !== 0xd9) {
      return false;
    }
    dimensions = jpegDimensions(input.prefix);
  } else {
    dimensions = webpDimensions(input.prefix, input.byteSize);
  }
  // shortcut: trusts bounded format headers for dimensions; use a bounded decoder if pixel decoding becomes required.
  return dimensionsWithinLimit(dimensions);
}
