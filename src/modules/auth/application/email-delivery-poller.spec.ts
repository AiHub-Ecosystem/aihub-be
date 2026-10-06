import { EmailDeliveryPoller } from './email-delivery-poller';
import { EmailPayloadUnknownKeyVersionError } from './email-delivery-request.port';
import type {
  ClaimEmailDeliveryRequestsInput,
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryErrorCode,
  EmailDeliveryKind,
  EmailDeliveryPayload,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  EmailPayloadCipherPort,
} from './email-delivery-request.port';
import type {
  EmailDispatchOptions,
  EmailSenderPort,
} from './email-sender.port';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const TOKEN = 'raw-opaque-token';
const TOKEN_HASH = 'a'.repeat(64);
const ROW_ID = 'edr_01J00000000000000000000000';
const VERIFICATION_PAYLOAD = {
  email: 'person@example.com',
  token: TOKEN,
  expiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
};

class FakeStore implements EmailDispatchStorePort {
  claims: ClaimEmailDeliveryRequestsInput[] = [];
  claimResult: EmailDeliveryRequestRecord[] = [];
  accepted: string[] = [];
  cancelled: { id: string; reason: string }[] = [];
  failed: { id: string; errorCode: string }[] = [];
  attempts: { id: string; errorCode: string }[] = [];
  reserved: string[] = [];
  deferred: string[] = [];
  unreported: EmailDeliveryRequestRecord[] = [];
  exhausted: EmailDeliveryRequestRecord[] = [];
  reconcileLimits: number[] = [];
  reported: string[] = [];
  claimed: string[] = [];
  released: string[] = [];

  async claim(
    input: ClaimEmailDeliveryRequestsInput,
  ): Promise<readonly EmailDeliveryRequestRecord[]> {
    this.claims.push(input);
    return this.claimResult;
  }

  async markProviderAccepted(input: { id: string }): Promise<void> {
    this.accepted.push(input.id);
  }

  async markCancelled(input: {
    id: string;
    reason: string;
  }): Promise<void> {
    this.cancelled.push({ id: input.id, reason: input.reason });
  }

  async markFailed(input: {
    id: string;
    errorCode: EmailDeliveryErrorCode;
  }): Promise<void> {
    this.failed.push({ id: input.id, errorCode: input.errorCode });
    // The real store makes the row terminal and unreported in the same commit,
    // which is what puts it in the reconciler's set for the rest of this pass.
    const row = this.claimResult.find((claimed) => claimed.id === input.id);
    if (row !== undefined) {
      this.unreported.push({
        ...row,
        status: 'failed',
        lastErrorCode: input.errorCode,
      });
    }
  }

  async recordFailedAttempt(input: {
    id: string;
    errorCode: string;
  }): Promise<void> {
    this.attempts.push({ id: input.id, errorCode: input.errorCode });
  }

  async reserveAttempt(input: { id: string }): Promise<void> {
    this.reserved.push(input.id);
  }

  async releaseDeferred(input: { id: string }): Promise<void> {
    this.deferred.push(input.id);
  }

  async failExhausted(): Promise<readonly EmailDeliveryRequestRecord[]> {
    // Giving up is a commit like any other, so the row lands in the reconciler's
    // set the same way a row failed during dispatch does.
    this.unreported.push(...this.exhausted);
    return this.exhausted;
  }

  async claimUnreportedFailures(input: {
    limit: number;
  }): Promise<readonly EmailDeliveryRequestRecord[]> {
    this.reconcileLimits.push(input.limit);
    const claimed = this.unreported.slice(0, input.limit);
    // The claim leases the row rather than reporting it, so a claimed row is
    // only reported once the callback returned and the stamp was written.
    this.claimed.push(...claimed.map((row) => row.id));
    return claimed;
  }

  async markFailureReported(input: { id: string }): Promise<void> {
    this.reported.push(input.id);
  }

  async releaseFailureNotification(input: { id: string }): Promise<void> {
    // Handing the claim back leaves the row in the unreported set, which is what
    // clearing the lease does in the store: the next pass can report it again.
    this.released.push(input.id);
  }
}

class FakeCredentials implements EmailCredentialActionabilityPort {
  state: EmailCredentialState = 'actionable';
  checked: { kind: EmailDeliveryKind; tokenHash: string }[] = [];

  async check(input: {
    kind: EmailDeliveryKind;
    tokenHash: string;
    now: Date;
  }): Promise<EmailCredentialState> {
    this.checked.push({ kind: input.kind, tokenHash: input.tokenHash });
    return this.state;
  }
}

interface RecordedSend {
  readonly kind: EmailDeliveryKind;
  readonly input: unknown;
  readonly idempotencyKey: string | undefined;
}

class RecordingSender implements EmailSenderPort {
  sends: RecordedSend[] = [];
  failure: Error | undefined;

  async sendVerificationEmail(
    input: unknown,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    await this.record('verification_email', input, options);
  }

  async sendPasswordResetEmail(
    input: unknown,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    await this.record('password_reset_email', input, options);
  }

  async sendOrganizationInviteEmail(
    input: unknown,
    options?: EmailDispatchOptions,
  ): Promise<void> {
    await this.record('organization_invite_email', input, options);
  }

  private async record(
    kind: EmailDeliveryKind,
    input: unknown,
    options: EmailDispatchOptions | undefined,
  ): Promise<void> {
    this.sends.push({ kind, input, idempotencyKey: options?.idempotencyKey });
    if (this.failure !== undefined) throw this.failure;
  }
}

function claimed(
  overrides: Partial<EmailDeliveryRequestRecord> = {},
): EmailDeliveryRequestRecord {
  return {
    id: ROW_ID,
    kind: 'verification_email',
    status: 'queued',
    payloadCiphertext: 'sealed',
    attempts: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    cancelReason: null,
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

function sealed(payload: EmailDeliveryPayload): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: (): string => JSON.stringify(payload),
  };
}

function unreadableCipher(): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: () => {
      throw new Error('email outbox envelope is malformed');
    },
  };
}

/**
 * An instance whose startup keyring predates the key version this row was sealed
 * with, which is what a gradual rotation leaves behind on the old instances.
 */
function unknownKeyVersionCipher(): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: () => {
      throw new EmailPayloadUnknownKeyVersionError();
    },
  };
}

function harness(
  options: {
    payload?: EmailDeliveryPayload;
    sender?: RecordingSender;
    credential?: EmailCredentialState;
    onTerminalFailure?: (failure: {
      readonly id: string;
      readonly kind: EmailDeliveryKind;
      readonly errorCode: string;
    }) => void;
  } = {},
): {
  poller: EmailDeliveryPoller;
  store: FakeStore;
  credentials: FakeCredentials;
  sender: RecordingSender;
} {
  const store = new FakeStore();
  const credentials = new FakeCredentials();
  credentials.state = options.credential ?? 'actionable';
  const sender = options.sender ?? new RecordingSender();
  const poller = new EmailDeliveryPoller(
    store,
    credentials,
    sealed(options.payload ?? VERIFICATION_PAYLOAD),
    sender,
    (): Date => NOW,
    { hash: () => TOKEN_HASH },
    {
      owner: 'instance-a',
      ...(options.onTerminalFailure === undefined
        ? {}
        : { onTerminalFailure: options.onTerminalFailure }),
    },
  );
  return { poller, store, credentials, sender };
}

describe('EmailDeliveryPoller', () => {
  it('hands an actionable verification request to the provider and records acceptance', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([
      {
        kind: 'verification_email',
        input: {
          email: 'person@example.com',
          token: TOKEN,
          expiresAt: new Date(NOW.getTime() + HOUR),
        },
        idempotencyKey: ROW_ID,
      },
    ]);
    expect(store.accepted).toEqual([ROW_ID]);
    expect(store.cancelled).toEqual([]);
    expect(summary).toEqual({
      claimed: 1,
      providerAccepted: 1,
      cancelled: 0,
      failed: 0,
    });
  });

  it('sends a password reset request for its own kind', async () => {
    const { poller, store, sender } = harness();
    store.claimResult = [claimed({ kind: 'password_reset_email' })];

    await poller.runOnce();

    expect(sender.sends.map((send) => send.kind)).toEqual([
      'password_reset_email',
    ]);
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

    expect(sender.sends[0]?.input).toEqual({
      email: 'person@example.com',
      organizationName: 'Resonance',
      role: 'admin',
      token: TOKEN,
      expiresAt: new Date(NOW.getTime() + HOUR),
    });
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
      async sendVerificationEmail() {
        call += 1;
        if (call === 1) throw new Error('Resend email delivery failed');
      },
      async sendPasswordResetEmail() {
        call += 1;
      },
      async sendOrganizationInviteEmail() {
        call += 1;
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
    });
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
    });
  });

  it('dispatches nothing when the claim returns no work', async () => {
    const { poller, sender } = harness();

    const summary = await poller.runOnce();

    expect(sender.sends).toEqual([]);
    expect(summary.claimed).toBe(0);
  });

  /**
   * The lease is what stops a second instance re-claiming a row this one is
   * still sending, so it has to cover the whole batch and not one request. The
   * cost of a request is its provider attempt plus the credential check and the
   * terminal write around it, and the margin is past that because the claim
   * predicate treats a lapsed lease as immediately reclaimable.
   */
  function worstCaseBatchMs(batchSize: number): number {
    return (
      batchSize *
      (EmailDeliveryPoller.ATTEMPT_TIMEOUT_MS +
        EmailDeliveryPoller.REQUEST_OVERHEAD_MS)
    );
  }

  it('claims a lease that outlives the whole default batch', async () => {
    const { poller, store } = harness();

    await poller.runOnce();

    const claim = store.claims[0];
    expect(claim?.limit).toBe(EmailDeliveryPoller.BATCH_SIZE);
    expect(claim?.leaseMs).toBeGreaterThan(
      worstCaseBatchMs(EmailDeliveryPoller.BATCH_SIZE),
    );
  });

  it('claims a lease that grows with a batch larger than the default', async () => {
    const store = new FakeStore();
    const poller = new EmailDeliveryPoller(
      store,
      new FakeCredentials(),
      sealed(VERIFICATION_PAYLOAD),
      new RecordingSender(),
      (): Date => NOW,
      { hash: () => TOKEN_HASH },
      { owner: 'instance-a', batchSize: 25 },
    );

    await poller.runOnce();

    const claim = store.claims[0];
    expect(claim?.limit).toBe(25);
    expect(claim?.leaseMs).toBeGreaterThan(worstCaseBatchMs(25));
  });

  it('bounds one provider attempt at five seconds', () => {
    expect(EmailDeliveryPoller.ATTEMPT_TIMEOUT_MS).toBe(5_000);
  });

  describe('terminal failure reporting', () => {
    it('reports a request that used its last attempt', async () => {
      const failures: unknown[] = [];
      const { poller, store, sender } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.claimResult = [
        claimed({
          id: 'edr_gone',
          kind: 'organization_invite_email',
          attempts: 2,
        }),
      ];
      sender.failure = new Error('Resend email delivery failed');

      await poller.runOnce();

      expect(failures).toEqual([
        {
          id: 'edr_gone',
          kind: 'organization_invite_email',
          errorCode: 'provider_rejected',
        },
      ]);
    });

    it('reports nothing while attempts remain', async () => {
      const failures: unknown[] = [];
      const { poller, store, sender } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.claimResult = [claimed({ attempts: 0 })];
      sender.failure = new Error('Resend email delivery failed');

      await poller.runOnce();

      expect(failures).toEqual([]);
    });

    it('gives up a request that used its last attempt without a recorded outcome', async () => {
      // A process that died between reserving the third attempt and writing the
      // outcome. The claim predicate excludes it because the cap is reached, so
      // nothing else would ever move it.
      const exhausted = claimed({
        status: 'queued',
        attempts: 3,
        lastErrorCode: 'provider_rejected',
      });
      const failures: unknown[] = [];
      const { poller, store, sender } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.exhausted = [exhausted];

      await poller.runOnce();

      expect(sender.sends).toEqual([]);
      expect(store.exhausted).toEqual([exhausted]);
      expect(failures).toHaveLength(1);
    });

    it('reports a terminal failure whose notification a restart never got to send', async () => {
      // What a process exit between the markFailed commit and the notification
      // leaves behind: a terminal row, its payload already erased, and no record
      // that anything was ever reported.
      const failures: unknown[] = [];
      const { poller, store } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.unreported = [
        claimed({
          status: 'failed',
          attempts: 3,
          payloadCiphertext: null,
          lastErrorCode: 'timeout',
          completedAt: NOW,
        }),
      ];

      await poller.runOnce();

      expect(failures).toEqual([
        { id: ROW_ID, kind: 'verification_email', errorCode: 'timeout' },
      ]);
      expect(store.reported).toEqual([ROW_ID]);
    });

    it('hands the notification back when the callback throws, so the next pass reports it', async () => {
      // A claim that recorded the report before emitting would lose this alert
      // for good: no later pass sees a row already marked reported. Handing the
      // claim back is what keeps the promise recoverable.
      const failures: unknown[] = [];
      let failNext = true;
      const { poller, store } = harness({
        onTerminalFailure: (failure) => {
          if (failNext) {
            failNext = false;
            throw new Error('the alert transport is unavailable');
          }
          failures.push(failure);
        },
      });
      store.unreported = [
        claimed({
          status: 'failed',
          attempts: 3,
          payloadCiphertext: null,
          lastErrorCode: 'timeout',
          completedAt: NOW,
        }),
      ];

      await poller.runOnce();

      expect(store.released).toEqual([ROW_ID]);
      expect(store.reported).toEqual([]);

      await poller.runOnce();

      expect(failures).toEqual([
        { id: ROW_ID, kind: 'verification_email', errorCode: 'timeout' },
      ]);
      expect(store.reported).toEqual([ROW_ID]);
    });

    it('stops reporting a terminal failure once the notification is recorded', async () => {
      // The store no longer returns a reported row, so a second pass over the
      // same durable state is silent: one event per terminal failure, not one
      // per pass.
      const failures: unknown[] = [];
      const { poller, store } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.unreported = [
        claimed({
          id: 'edr_gone',
          status: 'failed',
          lastErrorCode: 'provider_rejected',
        }),
      ];
      await poller.runOnce();
      store.unreported = [];
      await poller.runOnce();

      expect(failures).toHaveLength(1);
      expect(store.reported).toEqual(['edr_gone']);
    });

    it('records the notification of a request it just gave up on', async () => {
      const failures: unknown[] = [];
      const { poller, store, sender } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.claimResult = [claimed({ attempts: 2 })];
      sender.failure = new Error('Resend email delivery failed');

      await poller.runOnce();

      expect(failures).toHaveLength(1);
      expect(store.reported).toEqual([ROW_ID]);
    });

    it('reports nothing for a request it cancelled instead', async () => {
      const failures: unknown[] = [];
      const { poller, store } = harness({
        credential: 'closed',
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.claimResult = [claimed()];

      await poller.runOnce();

      expect(failures).toEqual([]);
    });

    it('reports nothing when the provider accepts the request', async () => {
      const failures: unknown[] = [];
      const { poller, store } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.claimResult = [claimed()];

      await poller.runOnce();

      expect(failures).toEqual([]);
    });

    /**
     * What a provider SDK rejects with, rather than with: the recipient, the
     * token, a slice of the submitted body, and the response envelope, all in
     * one message. None of it may reach the alert payload or the stored
     * evidence, which are the two things an operator ever reads.
     */
    it('keeps the recipient, token, body, and provider response out of the reported failure', async () => {
      const failures: unknown[] = [];
      const { poller, store, sender } = harness({
        onTerminalFailure: (failure) => failures.push(failure),
      });
      store.claimResult = [claimed({ attempts: 2 })];
      sender.failure = new Error(
        `Resend email delivery failed: {"statusCode":422,"name":"validation_error",` +
          `"message":"The email address ${VERIFICATION_PAYLOAD.email} is not valid",` +
          `"to":["${VERIFICATION_PAYLOAD.email}"],"text":"${TOKEN}"}`,
      );

      const summary = await poller.runOnce();

      const evidence = JSON.stringify({
        failures,
        stored: store.failed,
        summary,
      });
      for (const secret of [
        VERIFICATION_PAYLOAD.email,
        TOKEN,
        'validation_error',
        'statusCode',
      ]) {
        expect(evidence).not.toContain(secret);
      }
      // The bounded code is what is left, and it is the only failure evidence
      // the dispatch path is allowed to keep.
      expect(failures).toEqual([
        {
          id: ROW_ID,
          kind: 'verification_email',
          errorCode: 'provider_rejected',
        },
      ]);
      expect(store.failed).toEqual([
        { id: ROW_ID, errorCode: 'provider_rejected' },
      ]);
    });
  });
});
