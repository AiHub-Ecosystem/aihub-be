export type EmailSendRateReservation =
  | { readonly reserved: true }
  | { readonly reserved: false; readonly retryAfterMs: number };

export interface EmailSendRateLimiterPort {
  reserve(): Promise<EmailSendRateReservation>;
}

export const EMAIL_SEND_RATE_LIMITER = Symbol('EMAIL_SEND_RATE_LIMITER');
