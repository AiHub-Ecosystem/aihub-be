import { Value } from '@sinclair/typebox/value';

import { OPERATION_CATALOG } from './operation-catalog';
import { OPERATION_IDS } from './operation-id';

describe('operation catalog', () => {
  it('contains the active operations with unique public paths', () => {
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
  it('validates a grading response against its catalogued response contract', () => {
    const responseContract =
      OPERATION_CATALOG['writing.task1.grade'].responseContract;

    expect(
      Value.Check(responseContract, {
        overall_band: 6.5,
        language: 'vi',
        criteria: [
          'task_achievement',
          'coherence_cohesion',
          'lexical_resource',
          'grammatical_range_accuracy',
        ].map((id) => ({
          id,
          name: id,
          band: 6,
          band_reason: 'clear',
          strengths: [],
          improvements: [],
        })),
        summary: 'summary',
        suggestions: [],
        next_steps: [],
        annotations: [],
      }),
    ).toBe(true);
  });
});
