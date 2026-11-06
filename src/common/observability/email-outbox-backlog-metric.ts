import { Gauge, type Registry } from '@prometheus-io/client';
import type { EmailDeliveryKindLabel } from './email-outbox-cancellation-metric';

export interface EmailOutboxBacklogSample {
  readonly kind: EmailDeliveryKindLabel;
  readonly queued: number;
  readonly oldestAgeSeconds: number;
}

export function registerEmailOutboxBacklogMetric(registry: Registry) {
  let labels: readonly EmailDeliveryKindLabel[] = ['unknown'];
  let source: (() => Promise<readonly EmailOutboxBacklogSample[]>) | undefined;
  let pending: Promise<void> | undefined;
  const queued = new Gauge({
    name: 'aihub_email_outbox_queued',
    help: 'Email Delivery Requests queued, including rows with unknown kinds.',
    labelNames: ['kind'],
    registers: [registry],
    collect: read,
  });
  const oldestAge = new Gauge({
    name: 'aihub_email_outbox_oldest_queued_age_seconds',
    help: 'Age of the oldest Email Delivery Request still waiting for dispatch.',
    labelNames: ['kind'],
    registers: [registry],
    collect: read,
  });

  function read(): Promise<void> {
    if (source === undefined) return Promise.resolve();
    pending ??= (async () => {
      try {
        const samples = await source();
        for (const kind of labels) {
          const sample = samples.find((entry) => entry.kind === kind);
          queued.set({ kind }, sample?.queued ?? 0);
          oldestAge.set({ kind }, sample?.oldestAgeSeconds ?? 0);
        }
      } catch {
        queued.reset();
        oldestAge.reset();
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  return {
    setLabels(kinds: readonly EmailDeliveryKindLabel[]): void {
      labels = [...kinds, 'unknown'];
    },
    setSource(next: typeof source): void {
      source = next;
      if (next === undefined) {
        queued.reset();
        oldestAge.reset();
      }
    },
  };
}
