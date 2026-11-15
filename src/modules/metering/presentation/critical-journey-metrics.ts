import { Counter, Histogram } from '@prometheus-io/client';

import { registry, secondsOf } from '@/common/observability/metrics';

const requests = new Counter({
  name: 'aihub_critical_journey_requests_total',
  help: 'Completed responses for the fixed critical user journeys by gateway outcome.',
  labelNames: ['journey', 'outcome'],
  registers: [registry],
});
const overhead = new Histogram({
  name: 'aihub_gateway_overhead_duration_seconds',
  help: 'Request time excluding measured downstream wait, in seconds.',
  labelNames: ['journey'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export function recordCriticalJourneyMetrics(request: {
  readonly criticalJourney?: string;
  readonly outcome: string;
  readonly totalMs?: number;
  readonly downstreamMs?: number;
}): void {
  const journey = request.criticalJourney;
  if (journey === undefined) return;

  requests.inc({ journey, outcome: request.outcome });
  const seconds = secondsOf(
    Math.max(0, (request.totalMs ?? Number.NaN) - (request.downstreamMs ?? 0)),
  );
  if (seconds !== undefined) overhead.observe({ journey }, seconds);
}
