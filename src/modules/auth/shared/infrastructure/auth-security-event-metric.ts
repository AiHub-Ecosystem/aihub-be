import { Counter } from '@prometheus-io/client';

import { internalError } from '@/common/errors/app-error';
import { registry } from '@/common/observability/metrics';
import { AUTH_SECURITY_EVENT_NAMES } from '@/modules/auth/shared/application/auth-security-event.port';

const eventNames = new Set<string>(AUTH_SECURITY_EVENT_NAMES);

const authSecurityEvents = new Counter({
  name: 'aihub_auth_security_events_total',
  help: 'Auth security events, labelled only by a fixed event name.',
  labelNames: ['event'],
  registers: [registry],
});

for (const event of AUTH_SECURITY_EVENT_NAMES) {
  authSecurityEvents.inc({ event }, 0);
}

export function incrementAuthSecurityEvent(event: string): void {
  if (!eventNames.has(event)) {
    throw internalError('unmapped Auth security event');
  }
  authSecurityEvents.inc({ event });
}
