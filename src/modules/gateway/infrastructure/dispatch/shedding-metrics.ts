import { Gauge } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics/metrics';

let shedLevelValue = 0;

new Gauge({
  name: 'aihub_shed_level',
  help: 'Prioritized load-shedding level: 0 none, 1 best-effort, 2 standard as well.',
  registers: [registry],
  collect() {
    this.set(shedLevelValue);
  },
});

export function setSheddingLevelMetric(level: number): void {
  shedLevelValue = level;
}
