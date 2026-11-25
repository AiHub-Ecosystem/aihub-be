import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { RETRY_BUDGET_OPERATIONS } from '@/modules/gateway/application/graded-request/admit-graded-request';
import { GRADED_REQUEST_OPERATIONS } from './graded-request.decorator';

describe('graded request operations', () => {
  it('put exactly the operations that take an Idempotency-Key under the retry budget', () => {
    // Speaking grading jobs use question-grading admission with the create key.
    // Other keyed graded operations come from the public graded-route catalog.
    const idempotentOperations = GRADED_REQUEST_OPERATIONS.filter(
      (operation) => OPERATION_CATALOG[operation].idempotency !== 'none',
    );

    expect(
      [...idempotentOperations, 'speaking.v2.question-grading'].sort(),
    ).toEqual([...RETRY_BUDGET_OPERATIONS].sort());
  });
});
