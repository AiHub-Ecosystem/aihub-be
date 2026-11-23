import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics/metrics';

const clientSecretFailures = new Counter({
  name: 'aihub_auth_web_session_client_secret_failures_total',
  help: 'Web Session requests refused because the Customer Web BFF client secret was missing or wrong.',
  registers: [registry],
});

// A zero sample lets Prometheus alert on the first failed guess after a restart.
clientSecretFailures.inc(0);

export function recordWebSessionClientSecretFailure(): void {
  try {
    clientSecretFailures.inc();
  } catch {
    // A metrics failure must not change the admission decision.
  }
}
