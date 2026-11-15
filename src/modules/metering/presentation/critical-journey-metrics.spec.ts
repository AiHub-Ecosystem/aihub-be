import { sample } from '@/common/observability/metric-sample.testing';
import { recordCriticalJourneyMetrics } from './critical-journey-metrics';

describe('critical journey metrics', () => {
  it('records a bounded journey and gateway overhead without downstream wait', async () => {
    recordCriticalJourneyMetrics({
      outcome: 'success',
      totalMs: 840,
      downstreamMs: 810,
      criticalJourney: 'graded_request',
    });

    expect(
      await sample('aihub_critical_journey_requests_total', {
        journey: 'graded_request',
        outcome: 'success',
      }),
    ).toBeDefined();
    expect(
      Number(
        await sample('aihub_gateway_overhead_duration_seconds_sum', {
          journey: 'graded_request',
        }),
      ),
    ).toBeCloseTo(0.03);
  });

  it('clamps overhead at zero when millisecond rounding exceeds total time', async () => {
    recordCriticalJourneyMetrics({
      outcome: 'success',
      totalMs: 10,
      downstreamMs: 11,
      criticalJourney: 'authentication',
    });

    expect(
      Number(
        await sample('aihub_gateway_overhead_duration_seconds_sum', {
          journey: 'authentication',
        }),
      ),
    ).toBe(0);
  });
});
