import type { EmailDeliveryKind } from './email-delivery-request.port';
import {
  EMAIL_DELIVERY_KINDS,
  EMAIL_KIND_POLICIES,
} from './email-kind-handler.registry';

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPECTED_POLICIES: readonly {
  readonly kind: EmailDeliveryKind;
  readonly priorityTier: number;
  readonly dailyBudgetBucket: 'invitation' | 'priority';
  readonly staleCutoffMs: number;
  readonly staleCancellationReason: 'credential_expired' | 'not_actionable';
  readonly backpressureLifetimeMs: number | null;
}[] = [
  {
    kind: 'verification_email',
    priorityTier: 1,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: DAY_MS,
    staleCancellationReason: 'credential_expired',
    backpressureLifetimeMs: DAY_MS,
  },
  {
    kind: 'password_reset_email',
    priorityTier: 0,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: DAY_MS,
    staleCancellationReason: 'credential_expired',
    backpressureLifetimeMs: 60 * 60 * 1000,
  },
  {
    kind: 'organization_invite_email',
    priorityTier: 3,
    dailyBudgetBucket: 'invitation',
    staleCutoffMs: DAY_MS,
    staleCancellationReason: 'credential_expired',
    backpressureLifetimeMs: DAY_MS,
  },
  {
    kind: 'mfa_enabled_notification',
    priorityTier: 2,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: DAY_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
  },
  {
    kind: 'mfa_removed_notification',
    priorityTier: 2,
    dailyBudgetBucket: 'priority',
    staleCutoffMs: DAY_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
  },
  {
    kind: 'api_key_near_expiry_notification',
    priorityTier: 4,
    dailyBudgetBucket: 'invitation',
    staleCutoffMs: 14 * DAY_MS,
    staleCancellationReason: 'not_actionable',
    backpressureLifetimeMs: null,
  },
];

describe('Email Delivery kind policies', () => {
  it.each(EXPECTED_POLICIES)(
    'declares the complete policy and composer for $kind',
    ({ kind, ...expected }) => {
      const { handler, ...policy } = EMAIL_KIND_POLICIES[kind];

      expect(policy).toEqual(expected);
      expect(typeof handler.isPayload).toBe('function');
      expect(typeof handler.credential).toBe('function');
      expect(typeof handler.render).toBe('function');
    },
  );

  it('keeps the runtime kind vocabulary in declaration order', () => {
    expect(EMAIL_DELIVERY_KINDS).toEqual(
      EXPECTED_POLICIES.map(({ kind }) => kind),
    );
  });
});
