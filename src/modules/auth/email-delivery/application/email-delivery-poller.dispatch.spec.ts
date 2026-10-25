import {
  DEFER_RETRY_MS,
  EmailDeliveryPoller,
  MAX_CREDENTIAL_LIFETIME_MS,
} from './email-delivery-poller';
import {
  FakeCredentials,
  FakeEmailProviderOutageCircuit,
  FakeEmailSendRateLimiter,
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
import { EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS } from './email-provider-retry-after.policy';
import {
  EmailProviderTransportError,
  type EmailSenderPort,
} from './email-sender.port';

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

  it('renders MFA enabled notices through their own handler', async () => {
    const { poller, store, sender, credentials } = harness({
      payload: { email: 'person@example.com' },
    });
    store.claimResult = [claimed({ kind: 'mfa_enabled_notification' })];

    await poller.runOnce();

    expect(sender.sends[0]?.message).toEqual({
      recipient: 'person@example.com',
      subject: 'AIHUB two-factor authentication enabled',
      text: 'A TOTP second factor was enabled on your AIHUB account. If you did not make this change, contact AIHUB support immediately.',
    });
    expect(credentials.checked).toEqual([]);
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
        inviterUsername: 'alice',
      },
    });
    store.claimResult = [
      claimed({ id: 'edr_invite', kind: 'organization_invite_email' }),
    ];

    await poller.runOnce();

    expect(sender.sends[0]?.message.subject).toBe(
      'Lời mời tham gia một tổ chức trên AIHUB',
    );
    expect(sender.sends[0]?.message.text).toContain(
      'alice mời bạn tham gia tổ chức “Resonance” trên AIHUB với vai trò quản trị viên.',
    );
    expect(sender.sends[0]?.message.text).toContain(TOKEN);
    expect(sender.sends[0]?.idempotencyKey).toBe('edr_invite');
  });

  it('still sends a request queued before the inviter was sealed into its payload', async () => {
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
      'Lời mời tham gia một tổ chức trên AIHUB',
    );
    expect(sender.sends[0]?.message.text).toContain(
      'mời bạn tham gia tổ chức “Resonance” trên AIHUB với vai trò quản trị viên.',
    );
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

  it('keeps a request queued without spending an attempt when the shared rate cap is full', async () => {
    const { poller, store, sender } = harness({
      rateReservation: { reserved: false, retryAfterMs: 750 },
    });
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(store.reserved).toEqual([]);
    expect(store.attempts).toEqual([]);
    expect(store.deferred).toEqual([ROW_ID]);
    expect(store.deferredUntil).toEqual([new Date(NOW.getTime() + 750)]);
    expect(sender.sends).toEqual([]);
    expect(summary.deferred).toBe(1);
  });

  it('keeps over-budget mail queued until the credential expires or the budget resets', async () => {
    const reserve = jest.fn().mockResolvedValue({
      reserved: false,
      retryAfterMs: 12 * 60 * 60 * 1000,
    });
    const { poller, store, sender } = harness({
      dailySendBudget: { reserve, usage: async () => ({ used: 8, limit: 10 }) },
    });
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(reserve).toHaveBeenCalledWith('priority');
    expect(store.reserved).toEqual([]);
    expect(store.deferredUntil).toEqual([
      new Date(Date.parse(VERIFICATION_PAYLOAD.expiresAt)),
    ]);
    expect(sender.sends).toEqual([]);
    expect(summary.deferred).toBe(1);
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

  it('refunds an attempt and pauses the rest of the batch after a provider-wide 5xx', async () => {
    const { poller, store, sender, outageCircuit } = harness();
    outageCircuit.permit = { allowed: true, probeToken: 'probe-token' };
    store.claimResult = [
      claimed({ id: 'edr_first', attempts: 2 }),
      claimed({ id: 'edr_second' }),
    ];
    sender.response = { status: 503, retryAfter: undefined };

    const summary = await poller.runOnce();

    expect(store.unspent).toEqual([
      {
        id: 'edr_first',
        previousAttempts: 2,
        previousAttemptAt: null,
        retryAt: expect.any(Date),
      },
    ]);
    expect(outageCircuit.failures).toEqual([0]);
    expect(outageCircuit.failedProbeTokens).toEqual(['probe-token']);
    expect(sender.sends).toHaveLength(1);
    expect(store.deferred).toContain('edr_second');
    expect(store.attempts).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(summary.deferred).toBe(2);
  });

  it('releases the probe when recording the provider failure itself fails', async () => {
    const { poller, store, sender, outageCircuit } = harness();
    outageCircuit.permit = { allowed: true, probeToken: 'probe-token' };
    outageCircuit.recordFailureError = new Error('connection lost');
    store.claimResult = [claimed(), claimed({ id: 'edr_second' })];
    sender.response = { status: 503, retryAfter: undefined };

    const summary = await poller.runOnce();

    // Nothing reached shared state, so the probe must go back or every other
    // instance waits out the outage key's TTL (#1113).
    expect(outageCircuit.releases).toEqual(['probe-token']);
    expect(outageCircuit.failures).toEqual([]);
    expect(store.unspent).toHaveLength(1);
    expect(store.deferred).toContain('edr_second');
    expect(summary.deferred).toBe(2);
  });

  it('releases the probe when closing the circuit after a successful send fails', async () => {
    const { poller, store, outageCircuit } = harness();
    outageCircuit.permit = { allowed: true, probeToken: 'probe-token' };
    outageCircuit.recordReachableError = new Error('connection lost');
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    // The circuit state the DEL could not clear still holds the probe; it goes
    // back or every other instance waits out the stale margin (#1113).
    expect(outageCircuit.releases).toEqual(['probe-token']);
    expect(store.accepted).toEqual([ROW_ID]);
    expect(summary.providerAccepted).toBe(1);
  });

  it('keeps mail queued through more than three provider failures, then delivers it', async () => {
    let now = new Date(NOW);
    const { poller, store, sender } = harness({ now: () => new Date(now) });
    sender.response = { status: 503, retryAfter: undefined };

    for (let failure = 0; failure < 4; failure += 1) {
      store.claimResult = [claimed({ attempts: 0 })];
      await poller.runOnce();
      now = new Date(now.getTime() + 5_000);
    }

    sender.response = { status: 202, retryAfter: undefined };
    store.claimResult = [claimed({ attempts: 0 })];
    await poller.runOnce();

    expect(sender.sends).toHaveLength(5);
    expect(store.unspent).toHaveLength(4);
    expect(
      store.unspent.every((attempt) => attempt.previousAttempts === 0),
    ).toBe(true);
    expect(store.attempts).toEqual([]);
    expect(store.failed).toEqual([]);
    expect(store.accepted).toEqual([ROW_ID]);
  });

  it('does not reserve a send or spend an attempt while the shared circuit is open', async () => {
    const { poller, store, sender, outageCircuit } = harness();
    outageCircuit.permit = { allowed: false, retryAfterMs: 12_000 };
    store.claimResult = [claimed({ attempts: 2 })];

    const summary = await poller.runOnce();

    expect(store.reserved).toEqual([]);
    expect(store.attempts).toEqual([]);
    expect(sender.sends).toEqual([]);
    expect(store.deferredUntil).toEqual([new Date(NOW.getTime() + 12_000)]);
    expect(summary.deferred).toBe(1);
  });

  it('continues stale and terminal reconciliation while shared sends are paused', async () => {
    const { poller, store, outageCircuit } = harness();
    outageCircuit.permit = { allowed: false, retryAfterMs: 12_000 };
    store.stale = [claimed({ id: 'edr_stale' })];
    store.exhausted = [
      claimed({
        id: 'edr_exhausted',
        status: 'failed',
        lastErrorCode: 'timeout',
      }),
    ];
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(store.staleCutoffs).toHaveLength(2);
    expect(summary.cancelled).toBe(1);
    expect(store.reported).toEqual(['edr_exhausted']);
    expect(store.deferred).toContain(ROW_ID);
  });

  it('treats a Resend fetch rejection as provider-wide and refunds the attempt', async () => {
    const { poller, store, sender, outageCircuit } = harness();
    store.claimResult = [claimed({ attempts: 1 })];
    sender.failure = new EmailProviderTransportError();

    await poller.runOnce();

    expect(outageCircuit.failures).toEqual([0]);
    expect(store.unspent).toHaveLength(1);
    expect(store.attempts).toEqual([]);
    expect(store.failed).toEqual([]);
  });

  it.each([400, 422] as const)(
    'fails a %s response after one provider attempt',
    async (status) => {
      const terminalFailures: unknown[] = [];
      const { poller, store, sender, outageCircuit } = harness({
        onTerminalFailure: (failure) => terminalFailures.push(failure),
      });
      store.claimResult = [claimed()];
      sender.response = { status, retryAfter: undefined };

      const summary = await poller.runOnce();

      expect(sender.sends).toHaveLength(1);
      expect(store.failed).toEqual([
        { id: ROW_ID, errorCode: 'provider_permanent_rejection' },
      ]);
      expect(store.attempts).toEqual([]);
      expect(outageCircuit.reachable).toBe(1);
      expect(summary.failed).toBe(1);
      expect(terminalFailures).toEqual([
        {
          id: ROW_ID,
          kind: 'verification_email',
          errorCode: 'provider_permanent_rejection',
        },
      ]);
    },
  );

  it.each([401, 403] as const)(
    'holds the queue and emits one configuration alert for %s',
    async (status) => {
      const alerts: { status: number }[] = [];
      const { poller, store, sender, outageCircuit } = harness({
        onProviderConfigurationFailure: (failure) => alerts.push(failure),
      });
      store.claimResult = [claimed(), claimed({ id: 'edr_second' })];
      sender.response = { status, retryAfter: undefined };

      const summary = await poller.runOnce();

      expect(sender.sends).toHaveLength(1);
      expect(store.unspent).toEqual([
        {
          id: ROW_ID,
          previousAttempts: 0,
          previousAttemptAt: null,
          retryAt: new Date(NOW.getTime() + DEFER_RETRY_MS),
        },
      ]);
      expect(store.deferred).toEqual([ROW_ID, 'edr_second']);
      expect(outageCircuit.reachable).toBe(1);
      expect(alerts).toEqual([{ status }]);
      expect(summary.deferred).toBe(2);

      await poller.runOnce();

      expect(sender.sends).toHaveLength(1);
      expect(alerts).toEqual([{ status }]);
    },
  );

  it('alerts and retries the attempt rollback before exhausted-row reconciliation', async () => {
    const alerts: { status: number }[] = [];
    const { poller, store, sender } = harness({
      onProviderConfigurationFailure: (failure) => alerts.push(failure),
    });
    store.claimResult = [claimed({ attempts: 2 })];
    sender.response = { status: 401, retryAfter: undefined };
    const order: string[] = [];
    let releaseCalls = 0;
    const releaseUnspentAttempt = store.releaseUnspentAttempt.bind(store);
    store.releaseUnspentAttempt = async (input) => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error('store is unavailable');
      order.push('release');
      await releaseUnspentAttempt(input);
    };
    store.failExhausted = async () => {
      order.push('exhausted');
      return [];
    };

    await poller.runOnce();
    await poller.runOnce();

    expect(sender.sends).toHaveLength(1);
    expect(alerts).toEqual([{ status: 401 }]);
    expect(order).toEqual(['exhausted', 'release', 'exhausted']);
    expect(store.unspent).toHaveLength(1);
  });

  it('defers 429 without spending an attempt and honours Retry-After', async () => {
    const { poller, store, sender, outageCircuit } = harness();
    const previousAttemptAt = new Date(NOW.getTime() - 60_000);
    store.claimResult = [
      claimed({ attempts: 1, lastAttemptAt: previousAttemptAt }),
    ];
    sender.response = { status: 429, retryAfter: '30' };

    const summary = await poller.runOnce();

    expect(store.unspent).toEqual([
      {
        id: ROW_ID,
        previousAttempts: 1,
        previousAttemptAt,
        retryAt: new Date(NOW.getTime() + 30_000),
      },
    ]);
    expect(store.attempts).toEqual([]);
    expect(summary.deferred).toBe(1);
    expect(outageCircuit.failures).toEqual([30_000]);

    await poller.runOnce();

    expect(store.claims).toHaveLength(1);
    expect(sender.sends).toHaveLength(1);
  });

  it('measures delta Retry-After from when the provider responds', async () => {
    let currentTime = NOW;
    const { poller, store, sender } = harness({ now: () => currentTime });
    store.claimResult = [claimed()];
    jest.spyOn(sender, 'send').mockImplementation(async () => {
      currentTime = new Date(NOW.getTime() + 20_000);
      return { status: 429, retryAfter: '30' };
    });

    await poller.runOnce();

    expect(store.deferredUntil).toEqual([new Date(NOW.getTime() + 50_000)]);
  });

  it('accepts Retry-After HTTP dates and defaults for absent or invalid values', async () => {
    const httpDate = harness();
    httpDate.store.claimResult = [claimed()];
    httpDate.sender.response = {
      status: 429,
      retryAfter: 'Mon, 05 Oct 2026 12:00:30 GMT',
    };

    await httpDate.poller.runOnce();

    expect(httpDate.store.deferredUntil).toEqual([
      new Date(NOW.getTime() + 30_000),
    ]);

    for (const retryAfter of [
      'Monday, 05-Oct-26 12:00:30 GMT',
      'Mon Oct  5 12:00:30 2026',
    ]) {
      const obsoleteHttpDate = harness();
      obsoleteHttpDate.store.claimResult = [claimed()];
      obsoleteHttpDate.sender.response = { status: 429, retryAfter };

      await obsoleteHttpDate.poller.runOnce();

      expect(obsoleteHttpDate.store.deferredUntil).toEqual([
        new Date(NOW.getTime() + 30_000),
      ]);
    }

    for (const retryAfter of [
      undefined,
      'not-a-date',
      '10/05/2026 12:00:30 PM',
      'Tue, 05 Oct 2026 12:00:30 GMT',
    ]) {
      const defaultDelay = harness();
      defaultDelay.store.claimResult = [claimed()];
      defaultDelay.sender.response = { status: 429, retryAfter };

      await defaultDelay.poller.runOnce();

      expect(defaultDelay.store.deferredUntil).toEqual([
        new Date(NOW.getTime() + EMAIL_PROVIDER_RATE_LIMIT_RETRY_MS),
      ]);
    }

    const overFiftyYears = harness();
    overFiftyYears.store.claimResult = [claimed()];
    overFiftyYears.sender.response = {
      status: 429,
      retryAfter: 'Saturday, 23-Oct-76 12:00:30 GMT',
    };
    await overFiftyYears.poller.runOnce();
    expect(overFiftyYears.store.deferredUntil).toEqual([
      new Date(NOW.getTime() + 5_000),
    ]);

    const exactlyFiftyYears = harness();
    exactlyFiftyYears.store.claimResult = [claimed()];
    exactlyFiftyYears.sender.response = {
      status: 429,
      retryAfter: 'Monday, 05-Oct-76 12:00:00 GMT',
    };
    await exactlyFiftyYears.poller.runOnce();
    expect(exactlyFiftyYears.store.deferredUntil).toEqual([
      new Date('2076-10-05T12:00:00.000Z'),
    ]);
  });

  it('clamps oversized numeric Retry-After values to the maximum date', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed()];
    sender.response = { status: 429, retryAfter: '9'.repeat(400) };

    await poller.runOnce();

    expect(store.deferredUntil).toEqual([new Date(8_640_000_000_000_000)]);
  });

  it('retries unclassified 4xx responses under the bounded default policy', async () => {
    const { poller, store, sender, outageCircuit } = harness();
    store.claimResult = [claimed()];
    sender.response = { status: 404, retryAfter: undefined };

    await poller.runOnce();

    expect(store.attempts).toEqual([
      { id: ROW_ID, errorCode: 'provider_rejected' },
    ]);
    expect(store.failed).toEqual([]);
    expect(outageCircuit.reachable).toBe(1);
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
        return { status: 202, retryAfter: undefined };
      },
    } as EmailSenderPort;
    const store = new FakeStore();
    const first = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      sealed(VERIFICATION_PAYLOAD),
      failingThenWorking,
      new FakeEmailSendRateLimiter(),
      new FakeEmailProviderOutageCircuit(),
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

  it('fails and erases a request sealed with a key version this instance lacks', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    const failures: unknown[] = [];
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      unknownKeyVersionCipher(),
      sender,
      new FakeEmailSendRateLimiter(),
      new FakeEmailProviderOutageCircuit(),
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      {
        owner: 'instance-a',
        onTerminalFailure: (failure) => failures.push(failure),
      },
    );
    store.claimResult = [
      claimed({ payloadCiphertext: 'v2.retired.iv.tag.ciphertext' }),
    ];

    const summary = await poller.runOnce();

    expect(store.cancelled).toEqual([]);
    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'key_unavailable' },
    ]);
    expect(store.unreported[0]).toMatchObject({
      status: 'failed',
      payloadCiphertext: null,
      lastErrorCode: 'key_unavailable',
    });
    expect(store.attempts).toEqual([]);
    expect(sender.sends).toEqual([]);
    expect(failures).toEqual([
      { id: ROW_ID, kind: 'verification_email', errorCode: 'key_unavailable' },
    ]);
    expect(summary).toMatchObject({ failed: 1, cancelled: 0, deferred: 0 });
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
    'fails a request whose payload has %s, without sending or checking it',
    async (_case, payload) => {
      const { poller, store, credentials, sender } = harness({
        payload: payload as unknown as EmailDeliveryPayload,
      });
      store.claimResult = [claimed()];

      await poller.runOnce();

      // A payload that cannot be sent never will be; reaching the credential
      // check with it is what used to throw before the attempt was reserved and
      // leave the row to be claimed again on every pass.
      expect(store.failed).toEqual([
        { id: ROW_ID, errorCode: 'payload_unreadable' },
      ]);
      expect(store.cancelled).toEqual([]);
      expect(store.reserved).toEqual([]);
      expect(credentials.checked).toEqual([]);
      expect(sender.sends).toEqual([]);
    },
  );

  it('fails an invitation whose payload lacks its organization or role', async () => {
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

    expect(store.failed).toEqual([
      { id: 'edr_invite', errorCode: 'payload_unreadable' },
    ]);
    expect(store.cancelled).toEqual([]);
    expect(sender.sends).toEqual([]);
  });

  it('cancels requests older than every credential lifetime before claiming', async () => {
    const { poller, store } = harness();
    store.stale = [claimed({ id: 'edr_stale' })];

    const summary = await poller.runOnce();

    expect(store.staleCutoffs[0]?.createdAtOrBefore).toEqual(
      new Date(NOW.getTime() - MAX_CREDENTIAL_LIFETIME_MS),
    );
    expect(summary.cancelled).toBe(1);
  });

  it('treats the longest credential lifetime as one day', () => {
    // Verification and invitation tokens live 24 hours, password reset one;
    // the stale cutoff must follow the longest, or it would cancel a request
    // whose credential is still valid.
    expect(MAX_CREDENTIAL_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('fails a request whose payload can no longer be read, so it is reported and not mistaken for a cancellation', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      unreadableCipher(),
      sender,
      new FakeEmailSendRateLimiter(),
      new FakeEmailProviderOutageCircuit(),
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a' },
    );
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'payload_unreadable' },
    ]);
    expect(store.cancelled).toEqual([]);
    expect(store.unreported.map(({ id }) => id)).toEqual([ROW_ID]);
    expect(summary).toMatchObject({ failed: 1, cancelled: 0 });
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
      new FakeEmailSendRateLimiter(),
      new FakeEmailProviderOutageCircuit(),
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
