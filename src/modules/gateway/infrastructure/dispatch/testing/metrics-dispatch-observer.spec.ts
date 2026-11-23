import { sample } from '@/common/observability/metrics/metric-sample.testing';
import { getMetrics } from '@/common/observability/metrics/metrics';
import { metricsDispatchObserver } from '@/modules/gateway/infrastructure/dispatch/metrics-dispatch-observer';

describe('metricsDispatchObserver', () => {
  it('records retry admissions and budget refusals by bounded labels', async () => {
    metricsDispatchObserver.downstreamRetryEvent(
      'writing.task1.grade',
      'connection',
    );
    metricsDispatchObserver.downstreamRetryEvent(
      'writing.task1.grade',
      'budget_exhausted',
    );

    expect(
      await sample('aihub_downstream_retry_events_total', {
        operation: 'writing.task1.grade',
        reason: 'connection',
      }),
    ).toBe('1');
    expect(
      await sample('aihub_downstream_retry_events_total', {
        operation: 'writing.task1.grade',
        reason: 'budget_exhausted',
      }),
    ).toBe('1');
    expect(await getMetrics()).toContain(
      '# HELP aihub_downstream_retry_events_total Retry-policy admissions after backoff and retry-budget refusals by operation and reason.',
    );
  });
});
