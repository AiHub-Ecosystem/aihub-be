import {
  DEFER_RETRY_MS,
  EmailDeliveryPoller,
  MAX_CREDENTIAL_LIFETIME_MS,
} from './email-delivery-poller';
import {
  FakeCredentials,
  FakeStore,
  NOW,
  ROW_ID,
  RecordingSender,
  TOKEN,
  TOKEN_HASH,
  VERIFICATION_PAYLOAD,
  claimed,
  harness,
  sealed,
  unknownKeyVersionCipher,
  unreadableCipher,
} from './email-delivery-poller.spec-support';
import type { EmailDeliveryPayload } from './email-delivery-request.port';
import type { EmailSenderPort } from './email-sender.port';

describe('EmailDeliveryPoller', () => {
  it('dispatches MFA security notices without checking credential actionability', async () => {
    const payload: EmailDeliveryPayload = { email: 'person@example.com' };
    const { poller, store, sender, credentials } = harness({ payload });
    store.claimResult = [claimed({ kind: 'mfa_removed_notification' })];

    const summary = await poller.runOnce();

    expect(summary.providerAccepted).toBe(1);
    expect(credentials.checked).toEqual([]);
    expect(sender.sends).toEqual([
      {
        message: {
          recipient: 'person@example.com',
          subject: 'AIHUB two-factor authentication removed',
          text: 'The TOTP second factor was removed from your AIHUB account and all refresh and web sessions were ended. If you did not make this change, contact AIHUB support immediately.',
        },
        idempotencyKey: ROW_ID,
      },
    ]);
  });

  it('hands an actionable verification request to the provider and records acceptance', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.message).toMatchObject({
      recipient: 'person@example.com',
      subject: 'Xác minh địa chỉ email AIHUB',
    });
    expect(sender.sends[0]?.message.text).toContain(TOKEN);
    expect(sender.sends[0]?.idempotencyKey).toBe(ROW_ID);
    expect(store.accepted).toEqual([ROW_ID]);
    expect(store.cancelled).toEqual([]);
    expect(summary).toEqual({
      claimed: 1,
      providerAccepted: 1,
      cancelled: 0,
      failed: 0,
      deferred: 0,
    });
  });

  it('sends a password reset request for its own kind', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed({ kind: 'password_reset_email' })];

    await poller.runOnce();

    expect(sender.sends[0]?.message.subject).toBe('Đặt lại mật khẩu AIHUB');
    expect(store.accepted).toEqual([ROW_ID]);
  });

  it('sends the organization invitation with the name and role it was committed with', async () => {
    const { poller, store, sender } = harness({
      payload: {
        ...VERIFICATION_PAYLOAD,
        organizationName: 'Resonance',
        role: 'admin',
      },
    });
    store.claimResult = [
      claimed({ id: 'edr_invite', kind: 'organization_invite_email' }),
    ];

    await poller.runOnce();

    expect(sender.sends[0]?.message.subject).toBe(
      'Lời mời tham gia Resonance trên AIHUB',
    );
    expect(sender.sends[0]?.message.text).toContain('quản trị viên');
    expect(sender.sends[0]?.message.text).toContain(TOKEN);
    expect(sender.sends[0]?.idempotencyKey).toBe('edr_invite');
  });

  it('carries the same provider idempotency key on every attempt of one request', async () => {
    const { poller, store, sender } = harness();
    sender.failure = new Error('Resend email delivery failed');

    store.claimResult = [claimed({ attempts: 0 })];
    await poller.runOnce();
    store.claimResult = [claimed({ attempts: 1 })];
    await poller.runOnce();
    store.claimResult = [claimed({ attempts: 2 })];
    sender.failure = undefined;
    await poller.runOnce();

    expect(sender.sends.map((send) => send.idempotencyKey)).toEqual([
      ROW_ID,
      ROW_ID,
      ROW_ID,
    ]);
  });

  it('reserves the attempt before calling the provider, not after it answers', async () => {
    // A transition that fails after the provider already ran is swallowed, so
    // the only record that a provider call happened is the one taken before it.
    const { poller, store, sender } = harness();
    store.markProviderAccepted = async () => {
      throw new Error('store is unavailable');
    };
    store.claimResult = [claimed({ attempts: 1 })];

    await poller.runOnce();

    expect(store.reserved).toEqual([ROW_ID]);
    expect(sender.sends).toHaveLength(1);
    // The attempt the provider spent is already counted; the failed transition
    // adds nothing on top of it.
    expect(store.accepted).toEqual([]);
  });

  it('spends no attempt on a request it cancels before calling the provider', async () => {
    const { poller, store } = harness({ credential: 'closed' });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.reserved).toEqual([]);
    expect(store.cancelled).toEqual([{ id: ROW_ID, reason: 'not_actionable' }]);
  });

  it('records a retriable failure while attempts remain under the cap', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed({ attempts: 1 })];
    sender.failure = new Error('Resend email delivery failed');

    const summary = await poller.runOnce();

    expect(store.attempts).toEqual([
      { id: ROW_ID, errorCode: 'provider_rejected' },
    ]);
    expect(store.failed).toEqual([]);
    expect(summary.failed).toBe(0);
  });

  it('gives up on the third attempt instead of scheduling a fourth', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed({ attempts: 2 })];
    sender.failure = new Error('Resend email delivery failed');

    const summary = await poller.runOnce();

    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'provider_rejected' },
    ]);
    expect(store.attempts).toEqual([]);
    expect(summary.failed).toBe(1);
  });

  it('reports an attempt timeout as its own error code', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed({ attempts: 2 })];
    sender.failure = Object.assign(new Error('aborted'), {
      name: 'TimeoutError',
    });

    await poller.runOnce();

    expect(store.failed[0]?.errorCode).toBe('timeout');
  });

  it('cancels a request whose credential expiry has passed without calling the provider', async () => {
    const { poller, store, credentials, sender } = harness({
      payload: {
        ...VERIFICATION_PAYLOAD,
        expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      },
    });
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(store.cancelled).toEqual([
      { id: ROW_ID, reason: 'credential_expired' },
    ]);
    expect(credentials.checked).toEqual([]);
    expect(summary.cancelled).toBe(1);
  });

  it('cancels a request whose credential expires at this very instant', async () => {
    const { poller, store, sender } = harness({
      payload: { ...VERIFICATION_PAYLOAD, expiresAt: NOW.toISOString() },
    });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(store.cancelled[0]?.reason).toBe('credential_expired');
  });

  it('cancels a request whose credential was superseded before dispatch', async () => {
    const { poller, store, sender } = harness({ credential: 'closed' });
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(store.cancelled).toEqual([{ id: ROW_ID, reason: 'not_actionable' }]);
    expect(summary).toEqual({
      claimed: 1,
      providerAccepted: 0,
      cancelled: 1,
      failed: 0,
      deferred: 0,
    });
  });

  it('cancels a request whose credential was revoked before dispatch', async () => {
    const { poller, store, sender } = harness({ credential: 'missing' });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(store.cancelled[0]?.reason).toBe('not_actionable');
  });

  it('cancels a request the credential store reports as expired', async () => {
    const { poller, store } = harness({ credential: 'expired' });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.cancelled[0]?.reason).toBe('credential_expired');
  });

  it('checks actionability against the credential hash, never the raw token', async () => {
    const { poller, store, credentials } = harness();
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(credentials.checked).toEqual([
      { kind: 'verification_email', tokenHash: TOKEN_HASH },
    ]);
  });

  it('keeps dispatching the rest of a batch when one request fails', async () => {
    let call = 0;
    const failingThenWorking = {
      async send() {
        call += 1;
        if (call === 1) throw new Error('Resend email delivery failed');
      },
    } as EmailSenderPort;
    const store = new FakeStore();
    const first = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      sealed(VERIFICATION_PAYLOAD),
      failingThenWorking,
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a' },
    );
    store.claimResult = [
      claimed({ id: 'edr_first' }),
      claimed({ id: 'edr_second' }),
    ];

    const summary = await first.runOnce();

    expect(store.attempts).toEqual([
      { id: 'edr_first', errorCode: 'provider_rejected' },
    ]);
    expect(store.accepted).toEqual(['edr_second']);
    expect(summary).toEqual({
      claimed: 2,
      providerAccepted: 1,
      cancelled: 0,
      failed: 0,
      deferred: 0,
    });
  });

  it('leaves a request another instance can still open queued and unerased', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      unknownKeyVersionCipher(),
      sender,
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a' },
    );
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    // Cancelling here would erase a payload the instance that owns the key can
    // still deliver; the row goes back with its ciphertext and its attempts.
    expect(store.cancelled).toEqual([]);
    expect(store.deferred).toEqual([ROW_ID]);
    expect(store.attempts).toEqual([]);
    expect(sender.sends).toEqual([]);
    expect(summary).toEqual({
      claimed: 1,
      providerAccepted: 0,
      cancelled: 0,
      failed: 0,
      deferred: 1,
    });
  });

  it('keeps a deferred request out of every batch until its retry time', async () => {
    const store = new FakeStore();
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      unknownKeyVersionCipher(),
      new RecordingSender(),
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a' },
    );
    store.claimResult = [claimed()];

    await poller.runOnce();

    // Released for immediate reclaim, a batch of unopenable rows would come
    // back every pass and keep every newer request from being claimed.
    expect(store.deferredUntil).toEqual([
      new Date(NOW.getTime() + DEFER_RETRY_MS),
    ]);
  });

  it.each([
    [
      'a missing token',
      {
        email: 'person@example.com',
        expiresAt: VERIFICATION_PAYLOAD.expiresAt,
      },
    ],
    ['a non-string email', { ...VERIFICATION_PAYLOAD, email: 42 }],
    ['an empty expiry', { ...VERIFICATION_PAYLOAD, expiresAt: '' }],
    ['a JSON array', []],
  ])(
    'cancels a request whose payload has %s, without sending or checking it',
    async (_case, payload) => {
      const { poller, store, credentials, sender } = harness({
        payload: payload as unknown as EmailDeliveryPayload,
      });
      store.claimResult = [claimed()];

      await poller.runOnce();

      // A payload that cannot be sent never will be; reaching the credential
      // check with it is what used to throw before the attempt was reserved and
      // leave the row to be claimed again on every pass.
      expect(store.cancelled).toEqual([
        { id: ROW_ID, reason: 'not_actionable' },
      ]);
      expect(store.reserved).toEqual([]);
      expect(credentials.checked).toEqual([]);
      expect(sender.sends).toEqual([]);
    },
  );

  it('cancels an invitation whose payload lacks its organization or role', async () => {
    const { poller, store, sender } = harness({
      payload: {
        ...VERIFICATION_PAYLOAD,
        organizationName: 'Resonance',
        role: 'superuser',
      } as unknown as EmailDeliveryPayload,
    });
    store.claimResult = [
      claimed({ id: 'edr_invite', kind: 'organization_invite_email' }),
    ];

    await poller.runOnce();

    expect(store.cancelled).toEqual([
      { id: 'edr_invite', reason: 'not_actionable' },
    ]);
    expect(sender.sends).toEqual([]);
  });

  it('cancels requests older than every credential lifetime before claiming', async () => {
    const { poller, store } = harness();
    store.stale = [claimed({ id: 'edr_stale' })];

    const summary = await poller.runOnce();

    expect(store.staleCutoffs).toEqual([
      new Date(NOW.getTime() - MAX_CREDENTIAL_LIFETIME_MS),
    ]);
    expect(summary.cancelled).toBe(1);
  });

  it('treats the longest credential lifetime as one day', () => {
    // Verification and invitation tokens live 24 hours, password reset one;
    // the stale cutoff must follow the longest, or it would cancel a request
    // whose credential is still valid.
    expect(MAX_CREDENTIAL_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('cancels a request whose payload can no longer be read', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      unreadableCipher(),
      sender,
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a' },
    );
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(store.cancelled).toEqual([{ id: ROW_ID, reason: 'not_actionable' }]);
    expect(summary.cancelled).toBe(1);
  });

  it('leaves a request alone when the store refuses to move it, and finishes the batch', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    store.markProviderAccepted = async () => {
      throw new Error('store is unavailable');
    };
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      sealed(VERIFICATION_PAYLOAD),
      sender,
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a' },
    );
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(summary).toEqual({
      claimed: 1,
      providerAccepted: 0,
      cancelled: 0,
      failed: 0,
      deferred: 0,
    });
  });

  it('dispatches nothing when the claim returns no work', async () => {
    const { poller, sender } = harness();

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(summary.claimed).toBe(0);
  });
});
