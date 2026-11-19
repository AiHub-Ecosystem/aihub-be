import type { EmailNoticeResolvers } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import type { EmailDeliveryRequestRecord } from '@/modules/auth/email-delivery/application/email-delivery-request.types';
import type { EmailDailySendBudgetPort } from '@/modules/auth/email-delivery/application/email-send-daily-budget.port';
import type { EmailDeliveryPollerMaintenanceOptions } from './email-delivery-poller-maintenance';

export interface EmailDeliveryPollerOptions
  extends EmailDeliveryPollerMaintenanceOptions {
  /** Validated by the Auth composition root; unset deployments use token-only copy. */
  readonly customerWebBaseUrl?: string;
  /** Filled by the modules that own a notice's facts; see the port. */
  readonly notices?: EmailNoticeResolvers;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  /** True once shutdown has begun: no claim, and no provider call, after it. */
  readonly shouldStop?: () => boolean;
  /** One safe signal per credential outage, reset by the next accepted send. */
  readonly onProviderConfigurationFailure?: (failure: {
    readonly status: 401 | 403;
  }) => void;
  /** Runtime dispatch supplies the shared durable account budget. */
  readonly dailySendBudget?: EmailDailySendBudgetPort;
  /** One bounded signal per pass for a request only a newer release can open. */
  readonly onUnrecognisedPayload?: (request: {
    readonly kind: EmailDeliveryRequestRecord['kind'];
  }) => void;
}

export type EmailDispatchOutcome =
  | 'provider_accepted'
  | 'cancelled'
  | 'failed'
  | 'retried'
  | 'deferred'
  | 'provider_outage'
  | 'configuration_failure';
