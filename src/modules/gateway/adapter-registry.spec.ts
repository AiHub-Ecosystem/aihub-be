import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';

import { PRODUCTION_ADAPTERS } from './gateway.module';

const catalogOperations = Object.keys(OPERATION_CATALOG) as OperationId[];

function assertOneAdapterPerOperation(
  adapters: readonly DownstreamAdapter<unknown, unknown>[],
): void {
  const counts = new Map<OperationId, number>();
  for (const adapter of adapters) {
    counts.set(adapter.operation, (counts.get(adapter.operation) ?? 0) + 1);
  }
  for (const operation of catalogOperations) {
    const count = counts.get(operation) ?? 0;
    if (count !== 1) {
      throw new Error(`${operation}: expected 1 adapter, found ${count}`);
    }
  }
  for (const [operation, count] of counts) {
    if (!catalogOperations.includes(operation)) {
      throw new Error(`${operation}: adapter has no catalog entry`);
    }
    if (count !== 1) {
      throw new Error(`${operation}: expected 1 adapter, found ${count}`);
    }
  }
}

describe('production dispatch adapter registry (#2047)', () => {
  it('registers exactly one adapter for every catalog operation', () => {
    expect(() =>
      assertOneAdapterPerOperation(PRODUCTION_ADAPTERS),
    ).not.toThrow();
  });

  it('names the operation when its adapter is missing', () => {
    const withoutFirst = PRODUCTION_ADAPTERS.slice(1);

    expect(() => assertOneAdapterPerOperation(withoutFirst)).toThrow(
      `${PRODUCTION_ADAPTERS[0]?.operation}: expected 1 adapter, found 0`,
    );
  });

  it('names the operation when its adapter is duplicated', () => {
    const [first] = PRODUCTION_ADAPTERS;
    if (first === undefined) throw new Error('production registry is empty');

    expect(() =>
      assertOneAdapterPerOperation([...PRODUCTION_ADAPTERS, first]),
    ).toThrow(`${first.operation}: expected 1 adapter, found 2`);
  });
});
