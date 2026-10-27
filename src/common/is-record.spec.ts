import { isRecord } from './is-record';

describe('isRecord', () => {
  it.each([{}, { a: 1 }, Object.create(null)])('accepts %p', (value) => {
    expect(isRecord(value)).toBe(true);
  });

  it.each([null, undefined, [], [1], 'text', 1, true, () => ({})])(
    'refuses %p',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
