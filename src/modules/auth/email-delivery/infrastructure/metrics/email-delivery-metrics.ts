import { Counter } from '@prometheus-io/client';

import { registry } from '@/common/observability/metrics/metrics';
import { registerEmailDailySendBudgetMetric } from './email-daily-send-budget-metric';
import {
  type EmailOutboxBacklogSample,
  registerEmailOutboxBacklogMetric,
} from './email-outbox-backlog-metric';
import { registerEmailOutboxBackpressureMetric } from './email-outbox-backpressure-metric';
import {
  type EmailDeliveryKindLabel,
  registerEmailOutboxCancellationMetric,
} from './email-outbox-cancellation-metric';
import {
  type EmailOutboxWalSlotHealthSample,
  registerEmailOutboxWalMetric,
} from './email-outbox-wal-metric';
import { registerEmailProviderOutageMetric } from './email-provider-outage-metric';

export type { EmailOutboxWalSlotHealthSample } from './email-outbox-wal-metric';
export type { EmailOutboxBacklogSample } from './email-outbox-backlog-metric';
export type {
  EmailDeliveryKindLabel,
  EmailOutboxCancellationSample,
} from './email-outbox-cancellation-metric';

const emailOutboxWalMetric = registerEmailOutboxWalMetric(registry);
const emailOutboxBacklogMetric = registerEmailOutboxBacklogMetric(registry);

/**
 * The bounded email kinds are the whole label domain, so this counter cannot grow
 * a series per recipient. Cancellation has a separate durable timestamp gauge;
 * only `credential_expired` pages, while routine lifecycle reasons stay quiet.
 */
const emailDeliveryFailedTotal = new Counter({
  name: 'aihub_email_delivery_failed_total',
  help: 'Email Delivery Requests that used all their attempts without provider acceptance.',
  labelNames: ['kind'],
  registers: [registry],
});

/**
 * Counts passes that handed back a request whose payload only a newer release
 * can open (#484). Labelled by the bounded email kind, never by payload.
 */
const emailOutboxUnrecognisedPayloadTotal = new Counter({
  name: 'aihub_email_outbox_unrecognised_payload_total',
  help: 'Email Delivery Requests handed back because their payload holds a value this release does not know.',
  labelNames: ['kind'],
  registers: [registry],
});

export function recordEmailDeliveryFailed(kind: EmailDeliveryKindLabel): void {
  emailDeliveryFailedTotal.inc({ kind });
}

export function recordEmailOutboxUnrecognisedPayload(
  kind: EmailDeliveryKindLabel,
): void {
  emailOutboxUnrecognisedPayloadTotal.inc({ kind });
}

export function setEmailOutboxWalHealthSource(
  source: (() => Promise<EmailOutboxWalSlotHealthSample | null>) | undefined,
): void {
  emailOutboxWalMetric.setSource(source);
}

/**
 * Registers where the backlog gauges read from. Only the process that owns an
 * outbox registers one; until then the gauges expose no series.
 */
export function setEmailOutboxBacklogSource(
  source: (() => Promise<readonly EmailOutboxBacklogSample[]>) | undefined,
): void {
  emailOutboxBacklogMetric.setSource(source);
}

export const setEmailOutboxCancellationSource =
  registerEmailOutboxCancellationMetric(registry);
const emailOutboxBackpressureMetric =
  registerEmailOutboxBackpressureMetric(registry);
export const recordEmailOutboxBackpressureRefusal = (kind: string): void =>
  emailOutboxBackpressureMetric.record(kind);
export const setEmailDailySendBudgetSource =
  registerEmailDailySendBudgetMetric(registry);
export const setEmailProviderOutageDurationSource =
  registerEmailProviderOutageMetric(registry);

/** Registers the bounded labels supplied by the owning Auth module. */
export function registerEmailDeliveryMetrics(
  kinds: readonly EmailDeliveryKindLabel[],
  backpressureKinds: readonly EmailDeliveryKindLabel[],
): void {
  emailOutboxBacklogMetric.setLabels(kinds);
  for (const kind of kinds) {
    emailDeliveryFailedTotal.inc({ kind }, 0);
    emailOutboxUnrecognisedPayloadTotal.inc({ kind }, 0);
  }
  emailOutboxBackpressureMetric.registerKinds(backpressureKinds);
}
