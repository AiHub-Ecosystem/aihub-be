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

  it('marks grading response contracts as unresolved until the real fixture exists', () => {
    expect(OPERATION_CATALOG['writing.task1.grade'].responseContract).toBe(
      'unresolved',
    );
    expect(OPERATION_CATALOG['writing.task2.grade'].responseContract).toBe(
      'unresolved',
    );
    const responseContract =
      OPERATION_CATALOG['writing.task1.question.generate'].responseContract;

    expect(
      Value.Check(responseContract, {
        question: 'Write about a chart',
        topic: 'Work',
        image_url: 'https://example.com/chart.png',
      }),
    ).toBe(true);
  });
});
