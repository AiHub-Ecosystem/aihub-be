import type { EmailDeliveryKind } from './email-delivery-request.port';
import type { EmailDailySendBudgetLimits } from './email-send-daily-budget.port';

export function emailDailySendBudgetLimits(
  dailyBudget: number,
): EmailDailySendBudgetLimits {
  return {
    dailyBudget,
    invitationBudget: Math.floor(dailyBudget * 0.8),
  };
}

/** A notice shares the invitation cap, so recovery mail keeps its fifth (ADR-0120). */
export function emailDailySendBudgetCategory(
  kind: EmailDeliveryKind,
): 'invitation' | 'priority' {
  return kind === 'organization_invite_email' ||
    kind === 'api_key_near_expiry_notification'
    ? 'invitation'
    : 'priority';
}
