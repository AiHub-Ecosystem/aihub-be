import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';

const droppedSamples = new Counter({
  name: 'aihub_public_api_major_usage_samples_dropped_total',
  help: 'Public API major usage samples dropped after the in-process buffer filled.',
  registers: [registry],
});

export function recordPublicApiMajorUsageDrop(): void {
  try {
    droppedSamples.inc();
  } catch {
    // A metrics failure must not affect a completed customer response.
  }
}
