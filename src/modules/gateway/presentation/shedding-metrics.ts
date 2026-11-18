import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';
import type { RequestTier } from '@/modules/gateway/application/shedding/request-tier';

const TIERS: readonly RequestTier[] = ['critical', 'standard', 'best-effort'];

/**
 * The two counters `aihub:shed_ratio` divides: every request that reached the
 * shedding gate and every one it refused. The ratio is a recording rule rather
 * than a stored lifetime average, so a past burst stops counting once it ages
 * out of the window.
 */
const tierRequests = new Counter({
  name: 'aihub_tier_requests_total',
  help: 'Requests that reached the shedding gate, by priority tier.',
  labelNames: ['tier'],
  registers: [registry],
});

const shedRequests = new Counter({
  name: 'aihub_shed_requests_total',
  help: 'Requests refused by prioritized load shedding, by priority tier.',
  labelNames: ['tier'],
  registers: [registry],
});

// Zero samples let Prometheus read the first request or shed after a restart.
for (const tier of TIERS) {
  tierRequests.inc({ tier }, 0);
  shedRequests.inc({ tier }, 0);
}

export function recordTierOutcome(
  tier: RequestTier,
  outcome: 'admitted' | 'shed',
): void {
  try {
    tierRequests.inc({ tier });
    if (outcome === 'shed') shedRequests.inc({ tier });
  } catch {
    // An observability failure must not change the admission decision.
  }
}
