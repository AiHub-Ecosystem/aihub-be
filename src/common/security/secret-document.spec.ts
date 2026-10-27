import {
  asDocument,
  assertOnlyFields,
  requiredDocumentString,
} from './secret-document';

class LoaderError extends Error {}
const fail = (message: string): Error => new LoaderError(message);

describe('secret document checks', () => {
  it('refuses a value that is not a plain object, with the caller error class', () => {
    expect(() => asDocument([], 'bundle', fail)).toThrow(LoaderError);
    expect(() => asDocument(null, 'bundle', fail)).toThrow(
      'bundle has an invalid shape',
    );
    expect(asDocument({ a: 1 }, 'bundle', fail)).toEqual({ a: 1 });
  });

  it('refuses a field outside the allowed list', () => {
    expect(() =>
      assertOnlyFields({ a: 1, b: 2 }, ['a'], 'bundle', fail),
    ).toThrow('bundle contains unexpected fields');
    expect(() =>
      assertOnlyFields({ a: 1 }, ['a', 'b'], 'bundle', fail),
    ).not.toThrow();
  });

  it('refuses a missing or blank required string', () => {
    for (const record of [{}, { key: '' }, { key: '  ' }, { key: 3 }]) {
      expect(() =>
        requiredDocumentString(record, 'key', 'key is missing', fail),
      ).toThrow('key is missing');
    }
    expect(requiredDocumentString({ key: 'v' }, 'key', 'm', fail)).toBe('v');
  });
});
