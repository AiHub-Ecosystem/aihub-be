import { Gauge } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';

/**
 * #1997: whether this process currently receives token-revocation broadcasts.
 *
 * Production logged a subscriber connection error once at startup with no
 * record of whether the subscription came back. The adapter now republishes
 * this gauge on every transition, so an operator can tell a degraded
 * subscription from a healthy one without reading raw Redis errors.
 *
 * 1 = subscribed, 0 = not subscribed, absent = the adapter has no subscriber.
 */
const revocationSubscriberUp = new Gauge({
  name: 'aihub_token_revocation_subscriber_up',
  help: 'Whether this process is subscribed to token-revocation broadcasts (1 up, 0 down).',
  registers: [registry],
});

/** @param {boolean} subscribed */
export function recordRevocationSubscriberState(subscribed: boolean): void {
  try {
    revocationSubscriberUp.set(subscribed ? 1 : 0);
  } catch {
    // An observability failure must not change the seam's outage policy.
  }
}
