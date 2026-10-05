import { EmailDeliveryPoller } from './email-delivery-poller';
import type {
  EmailCredentialActionabilityPort,
  EmailCredentialState,
  EmailDeliveryKind,
  EmailDeliveryPayload,
  EmailDeliveryRequestRecord,
  EmailDispatchStorePort,
  EmailPayloadCipher,
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
  claimResult: EmailDeliveryRequestRecord[] = [];
  accepted: string[] = [];
  cancelled: { id: string; reason: string }[] = [];
  failed: { id: string; errorCode: string }[] = [];
  attempts: { id: string; errorCode: string }[] = [];

  async claim(): Promise<readonly EmailDeliveryRequestRecord[]> {
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

  async markFailed(input: { id: string; errorCode: string }): Promise<void> {
    this.failed.push({ id: input.id, errorCode: input.errorCode });
  }

  async recordFailedAttempt(input: {
    id: string;
    errorCode: string;
  }): Promise<void> {
    this.attempts.push({ id: input.id, errorCode: input.errorCode });
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

function sealed(payload: EmailDeliveryPayload): EmailPayloadCipher {
  return {
    encrypt: (): string => 'sealed',
    decrypt: (): string => JSON.stringify(payload),
  };
}

function unreadableCipher(): EmailPayloadCipher {
  return {
    encrypt: (): string => 'sealed',
    decrypt: () => {
      throw new Error('email outbox envelope is malformed');
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

  it('holds a lease long enough that one batch cannot be re-claimed mid-flight', () => {
    expect(EmailDeliveryPoller.LEASE_MS).toBeGreaterThan(
      EmailDeliveryPoller.BATCH_SIZE * EmailDeliveryPoller.ATTEMPT_TIMEOUT_MS,
    );
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
  });
});
