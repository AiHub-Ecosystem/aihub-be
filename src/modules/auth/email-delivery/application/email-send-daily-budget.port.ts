import type { EmailDeliveryKind } from './email-delivery-request.port';

export type EmailDailyBudgetReservation =
  | { readonly reserved: true }
  | { readonly reserved: false; readonly retryAfterMs: number };

export interface EmailDailySendBudgetPort {
  reserve(kind: EmailDeliveryKind): Promise<EmailDailyBudgetReservation>;
  usage(): Promise<{ readonly used: number; readonly limit: number }>;
}

export const EMAIL_DAILY_SEND_BUDGET = Symbol('EMAIL_DAILY_SEND_BUDGET');
