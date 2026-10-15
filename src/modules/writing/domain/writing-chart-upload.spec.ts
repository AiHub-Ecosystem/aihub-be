import {
  WRITING_CHART_MAX_BYTES,
  WRITING_CHART_MAX_PIXELS,
  verifyWritingChartBytes,
} from './writing-chart-upload';

function png(width = 1, height = 1) {
  const prefix = new Uint8Array(24);
  prefix.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(prefix.buffer);
  view.setUint32(8, 13, false);
  prefix.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  const suffix = new Uint8Array(12);
  suffix.set([0x49, 0x45, 0x4e, 0x44], 4);
  return { prefix, suffix, byteSize: 36 };
}

describe('verifyWritingChartBytes', () => {
  it('accepts bounded PNG headers and rejects mismatches, truncation, and huge dimensions', () => {
    const valid = png();
    expect(
      verifyWritingChartBytes({ contentType: 'image/png', ...valid }),
    ).toBe(true);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/png',
        ...valid,
        prefix: new TextEncoder().encode('<html>not a PNG</html>'),
      }),
    ).toBe(false);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/png',
        ...valid,
        suffix: new Uint8Array(12),
      }),
    ).toBe(false);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/png',
        ...png(WRITING_CHART_MAX_PIXELS + 1, 1),
      }),
    ).toBe(false);
    expect(WRITING_CHART_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(WRITING_CHART_MAX_PIXELS).toBe(20_000_000);
  });

  it('checks a JPEG frame marker and requires the end marker', () => {
    const prefix = new Uint8Array(21);
    prefix.set([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
    ]);
    const suffix = new Uint8Array([0xff, 0xd9]);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/jpeg',
        byteSize: 23,
        prefix,
        suffix,
      }),
    ).toBe(true);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/jpeg',
        byteSize: 23,
        prefix,
        suffix: new Uint8Array([0x00, 0x00]),
      }),
    ).toBe(false);
  });

  it('rejects a mismatched WebP container length', () => {
    const prefix = new Uint8Array(30);
    prefix.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(prefix.buffer).setUint32(4, 22, true);
    prefix.set(new TextEncoder().encode('WEBPVP8X'), 8);
    new DataView(prefix.buffer).setUint32(16, 10, true);
    prefix.set(
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      20,
    );
    expect(
      verifyWritingChartBytes({
        contentType: 'image/webp',
        byteSize: 40,
        prefix,
        suffix: new Uint8Array(12),
      }),
    ).toBe(false);
  });

  it('requires WebP image data instead of accepting only an extended header', () => {
    const prefix = new Uint8Array(30);
    prefix.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(prefix.buffer).setUint32(4, 22, true);
    prefix.set(new TextEncoder().encode('WEBPVP8X'), 8);
    new DataView(prefix.buffer).setUint32(16, 10, true);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/webp',
        byteSize: prefix.length,
        prefix,
        suffix: new Uint8Array(),
      }),
    ).toBe(false);
  });

  it('reads dimensions from a bounded VP8L frame header', () => {
    const prefix = new Uint8Array(25);
    prefix.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(prefix.buffer).setUint32(4, 17, true);
    prefix.set(new TextEncoder().encode('WEBPVP8L'), 8);
    new DataView(prefix.buffer).setUint32(16, 5, true);
    prefix.set([0x2f, 0x00, 0x00, 0x00, 0x00], 20);
    expect(
      verifyWritingChartBytes({
        contentType: 'image/webp',
        byteSize: prefix.length,
        prefix,
        suffix: new Uint8Array(),
      }),
    ).toBe(true);
  });
});
