import { Gauge, type Registry } from '@prometheus-io/client';

export type EmailDeliveryKindLabel =
  | 'verification_email'
  | 'password_reset_email'
  | 'organization_invite_email'
  | 'mfa_enabled_notification'
  | 'mfa_removed_notification';

export interface EmailOutboxCancellationSample {
  readonly kind: EmailDeliveryKindLabel;
  readonly reason:
    | 'credential_expired'
    | 'credential_superseded'
    | 'credential_revoked'
    | 'not_actionable';
  readonly timestampSeconds: number;
}

type Source = () => Promise<readonly EmailOutboxCancellationSample[]>;

export function registerEmailOutboxCancellationMetric(
  registry: Registry,
): (source: Source | undefined) => void {
  let source: Source | undefined;
  let pending: Promise<void> | undefined;
  const gauge = new Gauge({
    name: 'aihub_email_delivery_cancelled_timestamp_seconds',
    help: 'Unix timestamp of the latest durable cancellation by email kind and reason.',
    labelNames: ['kind', 'reason'],
    registers: [registry],
    collect() {
      if (source === undefined) return;
      pending ??= (async () => {
        try {
          this.reset();
          for (const sample of await source()) {
            this.set(
              { kind: sample.kind, reason: sample.reason },
              sample.timestampSeconds,
            );
          }
        } catch {
          this.reset();
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    },
  });

  return (nextSource) => {
    source = nextSource;
    if (source === undefined) gauge.reset();
  };
}
