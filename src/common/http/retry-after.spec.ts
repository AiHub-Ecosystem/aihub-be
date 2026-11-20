import { parseRetryAfter } from './retry-after';

const NOW = new Date('2026-10-05T12:00:00.000Z');

describe('parseRetryAfter', () => {
  it('reads delta-seconds relative to the injected clock', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
    expect(parseRetryAfter(' 30 ', NOW)).toBe(30_000);
  });

  it.each([
    ['IMF-fixdate', 'Mon, 05 Oct 2026 12:00:30 GMT'],
    ['RFC 850 date', 'Monday, 05-Oct-26 12:00:30 GMT'],
    ['asctime date', 'Mon Oct  5 12:00:30 2026'],
  ])('reads an elapsed %s', (_format, header) => {
    expect(parseRetryAfter(header, NOW)).toBe(30_000);
  });

  it('treats a past date as no wait', () => {
    expect(parseRetryAfter('Mon, 05 Oct 2026 11:59:30 GMT', NOW)).toBe(0);
  });

  it('bounds oversized hints to the maximum date', () => {
    expect(parseRetryAfter('9'.repeat(400), NOW)).toBe(
      8_640_000_000_000_000 - NOW.getTime(),
    );
  });

  it.each([
    undefined,
    '',
    'soon',
    '1.5',
    '-3',
    'Tue, 05 Oct 2026 12:00:30 GMT',
  ])('rejects the unusable hint %p', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeUndefined();
  });
});
