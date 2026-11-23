import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics/metrics';
import type { DpopTokenUse } from '@/modules/auth/web-sessions/application/user-access-token-dpop.port';

const SCHEMES = ['bearer', 'dpop'] as const;
const SESSIONS = ['web', 'refresh', 'none'] as const;

const userAccessTokenUse = new Counter({
  name: 'aihub_user_access_token_use_total',
  help: 'Verified User Access JWT presentations, by scheme and minting session kind. Use scheme="bearer",session="web" to see Bearer traffic left before DPoP enforcement.',
  labelNames: ['scheme', 'session'],
  registers: [registry],
});

// Zero samples make the first Bearer use after a restart visible to Prometheus.
for (const scheme of SCHEMES) {
  for (const session of SESSIONS)
    userAccessTokenUse.inc({ scheme, session }, 0);
}

export function recordUserAccessTokenUse(use: DpopTokenUse): void {
  try {
    userAccessTokenUse.inc({ scheme: use.scheme, session: use.session });
  } catch {
    // An observability failure must not change the authorization outcome.
  }
}
