import {
  observeDispatchDeadlineMsRemaining,
  recordDispatchCancelledByDeadline,
} from '@/common/observability/metrics';
import type { DispatchObserverPort } from '@/modules/gateway/application/dispatch-observer.port';

export const metricsDispatchObserver: DispatchObserverPort = {
  deadlineMsRemaining: observeDispatchDeadlineMsRemaining,
  cancelledByDeadline: recordDispatchCancelledByDeadline,
};
