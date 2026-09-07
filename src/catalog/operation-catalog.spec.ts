import { Value } from '@sinclair/typebox/value';

import { OPERATION_CATALOG } from './operation-catalog';
import { OPERATION_IDS } from './operation-id';

describe('operation catalog', () => {
  it('contains the four distinct Writing operations with unique public paths', () => {
    expect(Object.keys(OPERATION_CATALOG)).toEqual(OPERATION_IDS);

    const entries = Object.values(OPERATION_CATALOG);
    const paths = entries.map((operation) => operation.path);

    expect(new Set(paths).size).toBe(entries.length);
    expect(entries.every((operation) => operation.method === 'POST')).toBe(
      true,
    );
    expect(
      entries.every((operation) => operation.requiredScope.length > 0),
    ).toBe(true);
    expect(entries.every((operation) => operation.timeoutMs > 0)).toBe(true);
  });

  // Every entry now holds a real schema, so `ResponseContract`'s `'unresolved'`
  // branch is statically unreachable here. The type checker proves it; a
  // runtime assertion would be dead code.
  it('validates a Task 1 question against its catalogued response contract', () => {
    const responseContract =
      OPERATION_CATALOG['writing.task1.question.generate'].responseContract;

    expect(
      Value.Check(responseContract, {
        question_id: '4a7c819d-46f2-42f7-a1af-ec5e7c61d31e',
        question: 'Write about a chart',
        chart_type: 'Bar Chart',
        image_url: 'https://example.com/chart.png',
      }),
    ).toBe(true);

    // `topic` was the old field name and carried a subject, not a chart type.
    expect(
      Value.Check(responseContract, {
        question_id: '4a7c819d-46f2-42f7-a1af-ec5e7c61d31e',
        question: 'Write about a chart',
        topic: 'Work',
        image_url: 'https://example.com/chart.png',
      }),
    ).toBe(false);
  });
});
