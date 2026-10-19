import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-speaking');

// Every captured AI Speaking body: the success fixture and the failure
// captures (#247). They are scrubbed by hand; this keeps them scrubbed.
const CAPTURES = readdirSync(FIXTURES).filter((name) =>
  /^grading.*\.json$/.test(name),
);

// Vietnamese letters outside ASCII: provider feedback and anything a
// candidate said in Vietnamese.
const VIETNAMESE = /[À-ỹ]/;

function strings(
  value: unknown,
  path: string,
): Array<{ path: string; value: string }> {
  if (typeof value === 'string') {
    return [{ path, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      strings(item, `${path}.${key}`),
    );
  }
  return [];
}

describe('captured AI Speaking fixtures', () => {
  it('include the failure captures', () => {
    expect(CAPTURES).toEqual(
      expect.arrayContaining([
        'grading-no-speech.200.json',
        'grading-convert-audio.500.json',
        'grading-empty-audio.400.json',
      ]),
    );
  });

  it.each(CAPTURES)(
    '%s carries no Vietnamese text and no transcript',
    (name) => {
      const body: unknown = JSON.parse(
        readFileSync(join(FIXTURES, name), 'utf8'),
      );
      const found = strings(body, '$');

      expect(
        found.filter(({ value }) => VIETNAMESE.test(value)).map((s) => s.path),
      ).toEqual([]);
      expect(
        found
          .filter(
            ({ path }) =>
              /\.(text|word|letters|phone|sentence)$/.test(path) ||
              path.endsWith('_vi'),
          )
          .filter(({ value }) => value !== '[redacted]')
          .map((s) => s.path),
      ).toEqual([]);
    },
  );
});
