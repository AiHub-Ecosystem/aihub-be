import { isRecord } from './is-record';

describe('isRecord', () => {
  it.each([{}, { a: 1 }, Object.create(null)])('accepts %p', (value) => {
    expect(isRecord(value)).toBe(true);
  });

  it.each([
    { value: null },
    { value: undefined },
    { value: [] },
    { value: [1] },
    { value: 'text' },
    { value: 1 },
    { value: true },
    { value: () => ({}) },
  ])('refuses $value', ({ value }) => {
    expect(isRecord(value)).toBe(false);
  });
});
