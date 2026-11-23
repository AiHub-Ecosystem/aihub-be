import { Counter } from '@prometheus-io/client';

import {
  observeDispatchDeadlineMsRemaining,
  recordDispatchCancelledByDeadline,
  registry,
} from '@/common/observability/metrics/metrics';
import type { DispatchObserverPort } from '@/modules/gateway/application/dispatch/dispatch-observer.port';

const downstreamRetryEventsTotal = new Counter({
  name: 'aihub_downstream_retry_events_total',
  help: 'Retry-policy admissions after backoff and retry-budget refusals by operation and reason.',
  labelNames: ['operation', 'reason'],
  registers: [registry],
});

export const metricsDispatchObserver: DispatchObserverPort = {
  deadlineMsRemaining: observeDispatchDeadlineMsRemaining,
  cancelledByDeadline: recordDispatchCancelledByDeadline,
  downstreamRetryEvent: (operation, reason) => {
    downstreamRetryEventsTotal.inc({ operation, reason });
  },
};
