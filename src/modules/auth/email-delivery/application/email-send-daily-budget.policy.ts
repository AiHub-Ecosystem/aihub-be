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

export function emailDailySendBudgetCategory(
  kind: EmailDeliveryKind,
): 'invitation' | 'priority' {
  return kind === 'organization_invite_email' ? 'invitation' : 'priority';
}
