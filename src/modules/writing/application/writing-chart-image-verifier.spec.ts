import { verifyWritingChartImageHeaders } from './writing-chart-image-verifier';
import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_MAX_PIXELS,
} from './writing-chart-upload.policy';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
);
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 3, 3, 1, 0x11, 0, 2, 0x11, 0, 3,
  0x11, 0, 0xff, 0xd9,
]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
  0x20, 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 3, 0, 2, 0,
]);

function boundedImage(
  contentType: 'image/jpeg' | 'image/png' | 'image/webp',
  bytes: Uint8Array,
) {
  return {
    contentType,
    byteSize: bytes.byteLength,
    prefix: bytes,
    suffix: bytes,
  };
}

describe('verifyWritingChartImageHeaders', () => {
  it('matches JPEG, PNG, and WebP signatures and dimensions to the MIME type', () => {
    expect(
      verifyWritingChartImageHeaders(boundedImage('image/jpeg', JPEG)),
    ).toBe(true);
    expect(verifyWritingChartImageHeaders(boundedImage('image/png', PNG))).toBe(
      true,
    );
    expect(
      verifyWritingChartImageHeaders(boundedImage('image/webp', WEBP)),
    ).toBe(true);
    expect(
      verifyWritingChartImageHeaders(boundedImage('image/jpeg', PNG)),
    ).toBe(false);
  });

  it('rejects truncated image containers and dimensions above 20 megapixels', () => {
    const truncated = PNG.subarray(0, PNG.byteLength - 12);
    expect(
      verifyWritingChartImageHeaders(boundedImage('image/png', truncated)),
    ).toBe(false);

    const oversized = new Uint8Array(PNG);
    new DataView(oversized.buffer).setUint32(16, 4_500, false);
    new DataView(oversized.buffer).setUint32(20, 4_500, false);
    expect(4_500 * 4_500).toBeGreaterThan(WRITING_CHART_MAX_PIXELS);
    expect(
      verifyWritingChartImageHeaders(boundedImage('image/png', oversized)),
    ).toBe(false);
  });

  it('rejects objects above the compressed-byte limit before reading headers', () => {
    expect(
      verifyWritingChartImageHeaders({
        ...boundedImage('image/png', PNG),
        byteSize: WRITING_CHART_MAX_BYTES + 1,
      }),
    ).toBe(false);
  });
});
