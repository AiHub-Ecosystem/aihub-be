import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { RETRY_BUDGET_OPERATIONS } from '@/modules/gateway/application/admit-graded-request';
import { GRADED_REQUEST_OPERATIONS } from './graded-request.decorator';

describe('graded request operations', () => {
  it('put exactly the operations that take an Idempotency-Key under the retry budget', () => {
    // A graded operation that takes a key but is missing from
    // RETRY_BUDGET_OPERATIONS would let its repeats escape the budget unseen.
    const keyed = GRADED_REQUEST_OPERATIONS.filter(
      (operation) => OPERATION_CATALOG[operation].idempotency !== 'none',
    );

    expect([...keyed].sort()).toEqual([...RETRY_BUDGET_OPERATIONS].sort());
  });
});
