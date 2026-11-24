import type {
  ApiKeyNearExpiryNotificationPayload,
  EmailNoticeResolvers,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  type EmailDispatchOptions,
  type EmailMessage,
  type EmailProviderResponse,
  EmailProviderTransportError,
  type EmailSenderPort,
} from '@/modules/auth/email-delivery/application/email-sender.port';
import {
  FakeCredentials,
  FakeEmailProviderOutageCircuit,
  FakeEmailSendRateLimiter,
  FakeStore,
  NOW,
  ROW_ID,
  RecordingSender,
  claimed,
  harness,
  sealed,
} from '../../../../../../test/support/auth/email-delivery-poller.spec-support';
import { EmailDeliveryPoller } from './email-delivery-poller';

describe('EmailDeliveryPoller idempotency conflicts (#441)', () => {
  it('retries a concurrent-request conflict on a bounded attempt instead of rejecting it', async () => {
    const sender = new RecordingSender();
    sender.response = {
      status: 409,
      retryAfter: undefined,
      idempotencyConflict: 'concurrent',
    };
    const { poller, store } = harness({ sender });
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(summary.failed).toBe(0);
    expect(store.reserved).toEqual([ROW_ID]);
    expect(store.attempts).toEqual([
      { id: ROW_ID, errorCode: 'outcome_unknown' },
    ]);
    expect(store.failed).toEqual([]);
  });

  it('ends a concurrent conflict on the last attempt as outcome_unknown, not provider_rejected', async () => {
    const sender = new RecordingSender();
    sender.response = {
      status: 409,
      retryAfter: undefined,
      idempotencyConflict: 'concurrent',
    };
    const { poller, store } = harness({ sender });
    store.claimResult = [claimed({ attempts: 2 })];

    const summary = await poller.runOnce();

    expect(summary.failed).toBe(1);
    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'outcome_unknown' },
    ]);
  });

  it('fails a changed-payload conflict as outcome_unknown at once and reports it', async () => {
    const sender = new RecordingSender();
    sender.response = {
      status: 409,
      retryAfter: undefined,
      idempotencyConflict: 'payload_changed',
    };
    const reported: string[] = [];
    const { poller, store } = harness({
      sender,
      onTerminalFailure: (failure) => reported.push(failure.errorCode),
    });
    store.claimResult = [claimed()];

    const summary = await poller.runOnce();

    expect(summary.failed).toBe(1);
    expect(store.attempts).toEqual([]);
    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'outcome_unknown' },
    ]);
    expect(reported).toEqual(['outcome_unknown']);
  });

  it('keeps an unrecognised 409 on the bounded provider_rejected retry', async () => {
    const sender = new RecordingSender();
    sender.response = { status: 409, retryAfter: undefined };
    const { poller, store } = harness({ sender });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.attempts).toEqual([
      { id: ROW_ID, errorCode: 'provider_rejected' },
    ]);
  });
});

/**
 * Resend's documented key behaviour: a key it has accepted is remembered with
 * its payload, a retry under it with the same payload is suppressed, and one
 * with a different payload is answered `409 invalid_idempotent_request`.
 */
class KeyRememberingResend implements EmailSenderPort {
  readonly deliveries: string[] = [];
  loseResponses = 0;
  private readonly payloadByKey = new Map<string, string>();

  async send(
    message: EmailMessage,
    options?: EmailDispatchOptions,
  ): Promise<EmailProviderResponse> {
    const key = options?.idempotencyKey ?? '';
    const payload = JSON.stringify(message);
    const remembered = this.payloadByKey.get(key);
    if (remembered !== undefined) {
      return remembered === payload
        ? { status: 202, retryAfter: undefined }
        : {
            status: 409,
            retryAfter: undefined,
            idempotencyConflict: 'payload_changed',
          };
    }
    this.payloadByKey.set(key, payload);
    this.deliveries.push(message.subject);
    if (this.loseResponses > 0) {
      this.loseResponses -= 1;
      throw new EmailProviderTransportError();
    }
    return { status: 202, retryAfter: undefined };
  }
}

describe('EmailDeliveryPoller lost acknowledgement across a restart (#441)', () => {
  const PAYLOAD: ApiKeyNearExpiryNotificationPayload = {
    organizationId: 'org_123',
    userAccountId: 'usr_owner',
    apiKeyIds: ['key_a'],
  };

  it('records outcome_unknown when a renamed Organization changes the retried notice', async () => {
    const store = new FakeStore();
    let currentMs = NOW.getTime();
    const now = (): Date => new Date(currentMs);
    let organizationName = 'Resonance';
    const notices: EmailNoticeResolvers = {
      apiKeyNearExpiry: {
        resolve: async () => ({
          email: 'owner@example.com',
          organizationId: 'org_123',
          organizationName,
          apiKeys: [
            { id: 'key_a', name: 'Batch grader', expiresAt: new Date(NOW) },
          ],
        }),
      },
    };
    const resend = new KeyRememberingResend();
    resend.loseResponses = 1;
    const reported: string[] = [];
    // Each poller stands for one process; the store and the provider outlive it.
    const startProcess = (): EmailDeliveryPoller =>
      new EmailDeliveryPoller(
        store,
        new FakeCredentials(),
        sealed(PAYLOAD),
        resend,
        new FakeEmailSendRateLimiter(),
        new FakeEmailProviderOutageCircuit(),
        now,
        { hash: () => 'a'.repeat(64) },
        {
          owner: 'instance-a',
          notices,
          onTerminalFailure: (failure) => reported.push(failure.errorCode),
        },
      );
    store.claimResult = [claimed({ kind: 'api_key_near_expiry_notification' })];

    // The provider accepts the first handoff and the response is lost.
    const first = await startProcess().runOnce();
    expect(first.deferred).toBe(1);
    expect(resend.deliveries).toHaveLength(1);

    // The process restarts, and the notice's live facts change before retry.
    organizationName = 'Resonance Labs';
    currentMs += 60 * 60_000;
    const second = await startProcess().runOnce();

    expect(second.failed).toBe(1);
    expect(resend.deliveries).toHaveLength(1);
    expect(store.accepted).toEqual([]);
    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'outcome_unknown' },
    ]);
    expect(reported).toEqual(['outcome_unknown']);
  });
});
