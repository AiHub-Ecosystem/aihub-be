import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics';
import type { IdentityCacheKind } from './identity-cache-envelope';

const REJECTIONS = new Counter({
  name: 'aihub_identity_cache_integrity_rejections_total',
  help: 'Identity cache entries rejected because their authenticity could not be verified.',
  labelNames: ['cache_kind'],
  registers: [registry],
});

for (const cache_kind of ['api_key', 'jwks'] as const) {
  REJECTIONS.inc({ cache_kind }, 0);
}

export function recordIdentityCacheIntegrityRejection(
  cacheKind: IdentityCacheKind,
): void {
  try {
    REJECTIONS.inc({ cache_kind: cacheKind });
  } catch {
    // Metrics must not change an authentication or assertion decision.
  }
}
