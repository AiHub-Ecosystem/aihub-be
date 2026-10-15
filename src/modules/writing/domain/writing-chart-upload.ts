export const WRITING_CHART_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type WritingChartContentType =
  (typeof WRITING_CHART_CONTENT_TYPES)[number];
export type WritingChartEnvironment = 'production' | 'sandbox';

export const WRITING_CHART_MAX_BYTES = 10 * 1024 * 1024;
export const WRITING_CHART_MAX_PIXELS = 20_000_000;
export const WRITING_CHART_RANGE_BYTES = 64 * 1024;
export const WRITING_CHART_UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const WRITING_CHART_INTENT_TTL_MS = 60 * 60 * 1000;
export const WRITING_CHART_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const WRITING_CHART_RETENTION_MS = 24 * 60 * 60 * 1000;
export const WRITING_CHART_ORG_HOURLY_LIMIT = 5;

export const WRITING_CHART_BUCKETS = {
  production: {
    staging: 'aihub-writing-chart-staging',
    public: 'aihub-writing-charts',
  },
  sandbox: {
    staging: 'aihub-sandbox-writing-chart-staging',
    public: 'aihub-sandbox-writing-charts',
  },
} as const;

export interface WritingChartUploadIntent {
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: WritingChartEnvironment;
  readonly stagingKey: string;
  readonly publishedKey: string;
  readonly contentType: WritingChartContentType;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: 'open' | 'rejected' | 'publishing';
}

export type WritingChartAsset = Omit<WritingChartUploadIntent, 'status'> & {
  readonly status: 'published' | 'deleted';
  readonly publishedAt: Date;
  readonly retentionExpiresAt: Date;
  readonly imageUrl: string;
};

export function isWritingChartContentType(
  value: string | undefined,
): value is WritingChartContentType {
  return WRITING_CHART_CONTENT_TYPES.some(
    (contentType) => contentType === value,
  );
}

export function isWritingChartAssetId(value: string): boolean {
  return /^chart_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

export function writingChartStagingKey(assetId: string): string {
  return `writing-charts/${assetId}/staging`;
}

export function writingChartPublishedKey(assetId: string): string {
  return `writing-charts/${assetId}/published`;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function pixelsWithinLimit(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height <= WRITING_CHART_MAX_PIXELS;
}

function jpegDimensions(
  prefix: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (prefix.length < 4 || prefix[0] !== 0xff || prefix[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 4 <= prefix.length) {
    if (prefix[offset] !== 0xff) return undefined;
    while (prefix[offset] === 0xff) offset += 1;
    const marker = prefix[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) {
      return undefined;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > prefix.length) return undefined;
    const length = (prefix[offset]! << 8) | prefix[offset + 1]!;
    if (length < 2 || offset + length > prefix.length) return undefined;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 7) return undefined;
      return {
        height: (prefix[offset + 3]! << 8) | prefix[offset + 4]!,
        width: (prefix[offset + 5]! << 8) | prefix[offset + 6]!,
      };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(
  prefix: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (
    prefix.length < 20 ||
    ascii(prefix, 0, 4) !== 'RIFF' ||
    ascii(prefix, 8, 4) !== 'WEBP'
  ) {
    return undefined;
  }
  let offset = 12;
  while (offset + 8 <= prefix.length) {
    const kind = ascii(prefix, offset, 4);
    const chunkSize = u32le(prefix, offset + 4);
    const data = offset + 8;
    if (kind === 'VP8 ' && chunkSize >= 10 && data + 10 <= prefix.length) {
      if (
        (prefix[data]! & 0x01) !== 0 ||
        prefix[data + 3] !== 0x9d ||
        prefix[data + 4] !== 0x01 ||
        prefix[data + 5] !== 0x2a
      )
        return undefined;
      return {
        width: (prefix[data + 6]! | (prefix[data + 7]! << 8)) & 0x3fff,
        height: (prefix[data + 8]! | (prefix[data + 9]! << 8)) & 0x3fff,
      };
    }
    if (
      kind === 'VP8L' &&
      chunkSize >= 5 &&
      data + 5 <= prefix.length &&
      prefix[data] === 0x2f
    ) {
      const b1 = prefix[data + 1]!;
      const b2 = prefix[data + 2]!;
      const b3 = prefix[data + 3]!;
      const b4 = prefix[data + 4]!;
      if ((b4 & 0xe0) !== 0) return undefined;
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    const next = data + chunkSize + (chunkSize % 2);
    if (next > prefix.length) return undefined;
    offset = next;
  }
  return undefined;
}

/**
 * shortcut: checks bounded headers and end markers, not pixel decoding; upgrade
 * if the upload boundary adopts a bounded decoder.
 */
export function verifyWritingChartBytes(input: {
  readonly contentType: WritingChartContentType;
  readonly byteSize: number;
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
}): boolean {
  const { contentType, byteSize, prefix, suffix } = input;
  let dimensions:
    | { readonly width: number; readonly height: number }
    | undefined;
  if (contentType === 'image/png') {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    dimensions =
      prefix.length >= 24 &&
      pngSignature.every((byte, index) => prefix[index] === byte) &&
      u32be(prefix, 8) === 13 &&
      ascii(prefix, 12, 4) === 'IHDR' &&
      suffix.length >= 12 &&
      u32be(suffix, suffix.length - 12) === 0 &&
      ascii(suffix, suffix.length - 8, 4) === 'IEND'
        ? { width: u32be(prefix, 16), height: u32be(prefix, 20) }
        : undefined;
  } else if (contentType === 'image/jpeg') {
    dimensions =
      suffix.length >= 2 &&
      suffix[suffix.length - 2] === 0xff &&
      suffix[suffix.length - 1] === 0xd9
        ? jpegDimensions(prefix)
        : undefined;
  } else {
    const declaredSize = prefix.length >= 8 ? u32le(prefix, 4) + 8 : -1;
    dimensions = declaredSize === byteSize ? webpDimensions(prefix) : undefined;
  }
  return (
    dimensions !== undefined &&
    pixelsWithinLimit(dimensions.width, dimensions.height)
  );
}
