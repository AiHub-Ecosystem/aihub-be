import { readdirSync } from 'node:fs';

import { isRecord } from '@/common/is-record';
import {
  fixtureDirectory,
  fixtureJson,
} from '../../../test/support/json-fixtures';

// Every captured AI Speaking body: the success fixture and the failure
// captures (#247). They are scrubbed by hand; this keeps them scrubbed.
const CAPTURES = readdirSync(fixtureDirectory('ai-speaking')).filter((name) =>
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
  if (isRecord(value)) {
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
      const body: unknown = fixtureJson('ai-speaking', name);
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
