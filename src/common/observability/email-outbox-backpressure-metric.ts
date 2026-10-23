import { Counter, type Registry } from '@prometheus-io/client';

const GATED_KINDS = [
  'verification_email',
  'password_reset_email',
  'organization_invite_email',
] as const;

type GatedKind = (typeof GATED_KINDS)[number];

/**
 * Counts requests refused because the email outbox could not deliver within the
 * credential lifetime (#635). Each gated kind is exposed at 0, so the first
 * refusal after a restart is an increase Prometheus can see.
 */
export function registerEmailOutboxBackpressureMetric(
  registry: Registry,
): (kind: GatedKind) => void {
  const refusals = new Counter({
    name: 'aihub_email_outbox_backpressure_refusals_total',
    help: 'Requests refused at the boundary because the email outbox could not deliver within the credential lifetime, by kind.',
    labelNames: ['kind'],
    registers: [registry],
  });
  for (const kind of GATED_KINDS) refusals.inc({ kind }, 0);
  return (kind) => {
    refusals.inc({ kind });
  };
}
