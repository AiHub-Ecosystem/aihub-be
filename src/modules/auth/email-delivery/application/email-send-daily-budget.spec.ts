import {
  emailDailySendBudgetCategory,
  emailDailySendBudgetLimits,
} from './email-send-daily-budget.policy';

describe('email daily send budget policy', () => {
  it('reserves one fifth of the configured budget for priority mail', () => {
    expect(emailDailySendBudgetLimits(10)).toEqual({
      dailyBudget: 10,
      invitationBudget: 8,
    });
    expect(emailDailySendBudgetLimits(1)).toEqual({
      dailyBudget: 1,
      invitationBudget: 0,
    });
  });

  it('classifies only organization invitations as non-priority mail', () => {
    expect(emailDailySendBudgetCategory('organization_invite_email')).toBe(
      'invitation',
    );
    expect(emailDailySendBudgetCategory('password_reset_email')).toBe(
      'priority',
    );
  });
});
