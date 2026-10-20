import { Gauge } from '@prometheus-io/client';

import { type OperationId, isOperationId } from '@/catalog/operation-id';
import { registry } from './metrics';

const breakerState = new Gauge({
  name: 'aihub_breaker_state',
  help: 'Downstream circuit breaker state by operation: 0 closed, 1 open, 2 half-open.',
  labelNames: ['operation'],
  registers: [registry],
});

export function setDownstreamBreakerState(
  operation: OperationId,
  state: 0 | 1 | 2,
): void {
  if (!isOperationId(operation)) return;
  breakerState.set({ operation }, state);
}
