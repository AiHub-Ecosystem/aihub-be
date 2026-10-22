import { MAX_CREDENTIAL_LIFETIME_MS } from './email-delivery-poller';
import {
  NOW,
  ROW_ID,
  claimed,
  harness,
} from './email-delivery-poller.spec-support';
import { API_KEY_NEAR_EXPIRY_WINDOW_MS } from './email-delivery-request.port';
import type {
  ApiKeyNearExpiryNotificationPayload,
  EmailNoticeResolvers,
} from './email-delivery-request.port';

const PAYLOAD: ApiKeyNearExpiryNotificationPayload = {
  organizationId: 'org_123',
  userAccountId: 'usr_owner',
  apiKeyIds: ['key_a', 'key_b'],
};

function resolvers(
  resolved: Awaited<
    ReturnType<NonNullable<EmailNoticeResolvers['apiKeyNearExpiry']>['resolve']>
  >,
): EmailNoticeResolvers & {
  calls: { payload: unknown; now: Date }[];
} {
  const calls: { payload: unknown; now: Date }[] = [];
  return {
    calls,
    apiKeyNearExpiry: {
      resolve: async (payload, now) => {
        calls.push({ payload, now });
        return resolved;
      },
    },
  };
}

describe('EmailDeliveryPoller near-expiry notices', () => {
  it('sends the notice composed from what the resolver finds at dispatch', async () => {
    const notices = resolvers({
      email: 'owner@example.com',
      organizationId: 'org_123',
      organizationName: 'Resonance',
      apiKeys: [
        {
          id: 'key_b',
          name: 'Batch grader',
          expiresAt: new Date('2026-10-12T00:00:00.000Z'),
        },
      ],
    });
    const { poller, store, sender, credentials } = harness({
      payload: PAYLOAD,
      notices,
    });
    store.claimResult = [claimed({ kind: 'api_key_near_expiry_notification' })];

    const summary = await poller.runOnce();

    expect(summary.providerAccepted).toBe(1);
    expect(notices.calls).toEqual([{ payload: PAYLOAD, now: NOW }]);
    expect(credentials.checked).toEqual([]);
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.message.recipient).toBe('owner@example.com');
    expect(sender.sends[0]?.message.text).toContain('Batch grader (key_b)');
    expect(sender.sends[0]?.message.text).not.toContain('key_a');
    expect(sender.sends[0]?.idempotencyKey).toBe(ROW_ID);
  });

  it('cancels the notice as not actionable when nothing is left to tell', async () => {
    const { poller, store, sender } = harness({
      payload: PAYLOAD,
      notices: resolvers(undefined),
    });
    store.claimResult = [claimed({ kind: 'api_key_near_expiry_notification' })];

    await poller.runOnce();

    expect(store.cancelled).toEqual([{ id: ROW_ID, reason: 'not_actionable' }]);
    expect(store.reserved).toEqual([]);
    expect(sender.sends).toEqual([]);
  });

  it('leaves the notice queued in a process with no resolver registered', async () => {
    const { poller, store, sender } = harness({ payload: PAYLOAD });
    store.claimResult = [claimed({ kind: 'api_key_near_expiry_notification' })];

    await poller.runOnce();

    expect(store.cancelled).toEqual([]);
    expect(store.reserved).toEqual([]);
    expect(sender.sends).toEqual([]);
  });

  it('cancels a stale notice only after the notice window, not the credential lifetime', async () => {
    const { poller, store } = harness();

    await poller.runOnce();

    expect(store.staleCutoffs).toEqual([
      {
        createdAtOrBefore: new Date(NOW.getTime() - MAX_CREDENTIAL_LIFETIME_MS),
        kinds: [
          'verification_email',
          'password_reset_email',
          'organization_invite_email',
          'mfa_enabled_notification',
          'mfa_removed_notification',
        ],
      },
      {
        createdAtOrBefore: new Date(
          NOW.getTime() - API_KEY_NEAR_EXPIRY_WINDOW_MS,
        ),
        kinds: ['api_key_near_expiry_notification'],
      },
    ]);
  });
});
