export type EmailDailySendBudgetCategory = 'invitation' | 'priority';

export interface EmailDailySendBudgetLimits {
  readonly dailyBudget: number;
  readonly invitationBudget: number;
}

export type EmailDailyBudgetReservation =
  | { readonly reserved: true }
  | { readonly reserved: false; readonly retryAfterMs: number };

export interface EmailDailySendBudgetPort {
  reserve(
    category: EmailDailySendBudgetCategory,
  ): Promise<EmailDailyBudgetReservation>;
  usage(): Promise<{ readonly used: number; readonly limit: number }>;
}

export const EMAIL_DAILY_SEND_BUDGET = Symbol('EMAIL_DAILY_SEND_BUDGET');
