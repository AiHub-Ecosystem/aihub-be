import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { ListeningTestsResponseSchema } from './listening/tests';
import { ReadingTestsResponseSchema } from './reading/tests';
import { SpeakingLibraryResponseSchema } from './speaking/library';
import { WritingTemplateListResponseSchema } from './writing/template';

function loadFixture(filename: string): unknown {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), 'test', 'fixtures', 'legacy-backend', filename),
      'utf8',
    ),
  );
}

// The client cleans each legacy body to the public schema before checking it,
// so the fixtures are held to the same two steps.
const CASES: readonly [string, TSchema][] = [
  ['writing-template-task1.200.json', WritingTemplateListResponseSchema],
  ['writing-template-task2.200.json', WritingTemplateListResponseSchema],
  ['speaking-library.200.json', SpeakingLibraryResponseSchema],
  ['listening-tests.200.json', ListeningTestsResponseSchema],
  ['reading-tests.200.json', ReadingTestsResponseSchema],
];

describe('Legacy content contracts against captured fixtures', () => {
  it.each(CASES)(
    '%s matches its public schema once cleaned',
    (file, schema) => {
      expect(Value.Check(schema, Value.Clean(schema, loadFixture(file)))).toBe(
        true,
      );
    },
  );

  it('drops the Writing template author from the public response', () => {
    const cleaned = Value.Clean(
      WritingTemplateListResponseSchema,
      loadFixture('writing-template-task1.200.json'),
    );
    expect(JSON.stringify(cleaned)).not.toMatch(/"user(Id|Name)"/);
  });
});
