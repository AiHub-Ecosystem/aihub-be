import { Counter, type Registry } from '@prometheus-io/client';

/**
 * Counts requests refused because the email outbox could not deliver within the
 * credential lifetime (#635). Each gated kind is exposed at 0, so the first
 * refusal after a restart is an increase Prometheus can see.
 */
export function registerEmailOutboxBackpressureMetric(registry: Registry): {
  registerKinds(kinds: readonly string[]): void;
  record(kind: string): void;
} {
  const refusals = new Counter({
    name: 'aihub_email_outbox_backpressure_refusals_total',
    help: 'Requests refused at the boundary because the email outbox could not deliver within the credential lifetime, by kind.',
    labelNames: ['kind'],
    registers: [registry],
  });
  return {
    registerKinds(kinds) {
      for (const kind of kinds) refusals.inc({ kind }, 0);
    },
    record: (kind) => {
      refusals.inc({ kind });
    },
  };
}
