import * as fc from 'fast-check';

import { PROPERTY_OPTIONS } from '../../../test/support/property-options';
import { parseUtcTimestamp } from './parse-utc-timestamp';

const pad = (value: number): string => String(value).padStart(2, '0');

/** Every instant the `YYYY-MM-DDTHH:mm:ss.sssZ` format can express. */
const instantArbitrary = fc.date({
  min: new Date('0000-01-01T00:00:00.000Z'),
  max: new Date('9999-12-31T23:59:59.999Z'),
});

/** A field that is in range about half the time and out of it otherwise. */
const field = (min: number, max: number): fc.Arbitrary<number> =>
  fc.oneof(fc.integer({ min, max }), fc.integer({ min: 0, max: 99 }));

describe('parseUtcTimestamp properties', () => {
  it('round-trips every valid instant through toISOString', () => {
    fc.assert(
      fc.property(instantArbitrary, (instant) => {
        expect(parseUtcTimestamp(instant.toISOString())?.getTime()).toBe(
          instant.getTime(),
        );
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('reads a fraction of one to three digits as milliseconds, padded on the right', () => {
    fc.assert(
      fc.property(
        instantArbitrary,
        fc.stringMatching(/^[0-9]{1,3}$/),
        (instant, fraction) => {
          const wholeSecond = instant.toISOString().slice(0, 19);
          const expected =
            Math.floor(instant.getTime() / 1000) * 1000 +
            Number(fraction.padEnd(3, '0'));

          expect(
            parseUtcTimestamp(`${wholeSecond}.${fraction}Z`)?.getTime(),
          ).toBe(expected);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('accepts a field combination exactly when it names a real instant, never rolling it forward', () => {
    fc.assert(
      fc.property(
        fc.record({
          year: fc.integer({ min: 1000, max: 9999 }),
          month: field(1, 12),
          day: field(1, 31),
          hour: field(0, 23),
          minute: field(0, 59),
          second: field(0, 59),
        }),
        (f) => {
          const raw = `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}Z`;
          const instant = new Date(
            Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second),
          );
          const isReal =
            instant.getUTCFullYear() === f.year &&
            instant.getUTCMonth() === f.month - 1 &&
            instant.getUTCDate() === f.day &&
            instant.getUTCHours() === f.hour &&
            instant.getUTCMinutes() === f.minute &&
            instant.getUTCSeconds() === f.second;

          const parsed = parseUtcTimestamp(raw);

          expect(parsed?.getTime()).toBe(
            isReal ? instant.getTime() : undefined,
          );
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('rejects a valid instant that does not end in Z', () => {
    fc.assert(
      fc.property(
        instantArbitrary,
        fc.constantFrom('', 'z', ' ', '+00:00', '-07:00', '+0000', '+07'),
        (instant, suffix) => {
          expect(
            parseUtcTimestamp(`${instant.toISOString().slice(0, 19)}${suffix}`),
          ).toBeUndefined();
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('returns only an instant whose rendering matches the input, for any string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const parsed = parseUtcTimestamp(raw);

        const rendersAsInput =
          parsed === undefined ||
          (raw.slice(0, 19) === parsed.toISOString().slice(0, 19) &&
            raw.endsWith('Z'));

        expect(rendersAsInput).toBe(true);
      }),
      PROPERTY_OPTIONS,
    );
  });
});
