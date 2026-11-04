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

  it('classifies organization invitations and notices as non-priority mail', () => {
    expect(emailDailySendBudgetCategory('organization_invite_email')).toBe(
      'invitation',
    );
    // ADR-0120: a notice gives way to recovery mail before anything else does.
    expect(
      emailDailySendBudgetCategory('api_key_near_expiry_notification'),
    ).toBe('invitation');
    expect(emailDailySendBudgetCategory('password_reset_email')).toBe(
      'priority',
    );
  });
});
