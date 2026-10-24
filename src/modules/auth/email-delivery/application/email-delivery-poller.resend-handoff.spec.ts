import { EmailDeliveryPoller } from './email-delivery-poller';
import {
  FakeCredentials,
  FakeEmailProviderOutageCircuit,
  FakeEmailSendRateLimiter,
  FakeStore,
  NOW,
  ROW_ID,
  claimed,
  sealed,
} from './email-delivery-poller.spec-support';
import type {
  ApiKeyNearExpiryNotificationPayload,
  EmailNoticeResolvers,
} from './email-delivery-request.port';
import type {
  EmailDispatchOptions,
  EmailMessage,
  EmailProviderResponse,
  EmailSenderPort,
} from './email-sender.port';
import { EmailProviderTransportError } from './email-sender.port';

/** Resend documents idempotency-key retention of 24 hours. */
const RESEND_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

const PAYLOAD: ApiKeyNearExpiryNotificationPayload = {
  organizationId: 'org_123',
  userAccountId: 'usr_owner',
  apiKeyIds: ['key_a'],
};

const notices = (): EmailNoticeResolvers => ({
  apiKeyNearExpiry: {
    resolve: async () => ({
      email: 'owner@example.com',
      organizationId: 'org_123',
      organizationName: 'Resonance',
      apiKeys: [
        { id: 'key_a', name: 'Batch grader', expiresAt: new Date(NOW) },
      ],
    }),
  },
});

/**
 * Simulates the handoff Resend actually offers: a send is accepted and its
 * idempotency key remembered for 24 hours, so a retry under a remembered key
 * is suppressed instead of delivered again. A key the retention window has
 * passed is forgotten, so the same key can deliver a second copy — which is
 * why AIHUB does not guarantee exactly-once delivery once provider retention
 * expires (ADR-0122).
 */
class SimulatedResend implements EmailSenderPort {
  /** Emails the provider actually delivered. */
  readonly deliveries: { recipient: string; idempotencyKey: string }[] = [];
  /** Keys a retried send was suppressed under, provider-side. */
  readonly suppressed: string[] = [];
  /** Every key AIHUB handed the provider, one entry per handoff. */
  readonly keyCalls: string[] = [];
  /** Accepted sends whose response is lost instead of answered. */
  loseResponses = 0;
  private readonly acceptedAt = new Map<string, number>();

  constructor(private readonly now: () => Date) {}

  async send(
    message: EmailMessage,
    options?: EmailDispatchOptions,
  ): Promise<EmailProviderResponse> {
    const idempotencyKey = options?.idempotencyKey ?? '';
    this.keyCalls.push(idempotencyKey);
    const at = this.now().getTime();
    const acceptedAt = this.acceptedAt.get(idempotencyKey);
    if (
      acceptedAt !== undefined &&
      at - acceptedAt < RESEND_IDEMPOTENCY_RETENTION_MS
    ) {
      this.suppressed.push(idempotencyKey);
      return { status: 202, retryAfter: undefined };
    }
    this.deliveries.push({ recipient: message.recipient, idempotencyKey });
    this.acceptedAt.set(idempotencyKey, at);
    if (this.loseResponses > 0) {
      this.loseResponses -= 1;
      throw new EmailProviderTransportError();
    }
    return { status: 202, retryAfter: undefined };
  }
}

/**
 * The near-expiry notice is the one kind whose queued rows outlive the
 * provider's retention window (14 days against 24 hours), so it is the kind
 * that can still be retried after Resend forgot the key.
 */
function harnessWithResend(): {
  poller: EmailDeliveryPoller;
  store: FakeStore;
  resend: SimulatedResend;
  advanceMs: (ms: number) => void;
} {
  const store = new FakeStore();
  let currentMs = NOW.getTime();
  const now = (): Date => new Date(currentMs);
  const resend = new SimulatedResend(now);
  const poller = new EmailDeliveryPoller(
    store,
    new FakeCredentials(),
    sealed(PAYLOAD),
    resend,
    new FakeEmailSendRateLimiter(),
    new FakeEmailProviderOutageCircuit(),
    now,
    { hash: () => 'a'.repeat(64) },
    { owner: 'instance-a', notices: notices() },
  );
  return {
    poller,
    store,
    resend,
    advanceMs: (ms) => {
      currentMs += ms;
    },
  };
}

describe('EmailDeliveryPoller ambiguous Resend handoff', () => {
  it('deduplicates the retry when the lost response is retried inside the retention window', async () => {
    const { poller, store, resend, advanceMs } = harnessWithResend();
    resend.loseResponses = 1;
    store.claimResult = [claimed({ kind: 'api_key_near_expiry_notification' })];

    // Resend accepted the email and lost the response: the poller saw an
    // outage and handed the row back without spending its attempt.
    const first = await poller.runOnce();
    expect(first.deferred).toBe(1);
    expect(resend.deliveries).toHaveLength(1);
    expect(store.accepted).toEqual([]);

    advanceMs(6_000);
    const second = await poller.runOnce();

    expect(second.providerAccepted).toBe(1);
    expect(store.accepted).toEqual([ROW_ID]);
    // One email out, two handoffs: the retry carried the same stable key and
    // the provider suppressed it as a duplicate.
    expect(resend.keyCalls).toEqual([ROW_ID, ROW_ID]);
    expect(resend.deliveries).toEqual([
      { recipient: 'owner@example.com', idempotencyKey: ROW_ID },
    ]);
    expect(resend.suppressed).toEqual([ROW_ID]);
  });

  it('can deliver a duplicate once the provider forgets the key past its retention, so exactly-once ends there', async () => {
    const { poller, store, resend, advanceMs } = harnessWithResend();
    resend.loseResponses = 1;
    store.claimResult = [claimed({ kind: 'api_key_near_expiry_notification' })];

    const first = await poller.runOnce();
    expect(first.deferred).toBe(1);
    expect(resend.deliveries).toHaveLength(1);

    // AIHUB still retries the same row under the same key; the provider no
    // longer remembers it, so the duplicate is accepted and delivered. This is
    // the documented boundary: past provider retention, exactly-once delivery
    // is not guaranteed (ADR-0122).
    advanceMs(RESEND_IDEMPOTENCY_RETENTION_MS + 60_000);
    const second = await poller.runOnce();

    expect(second.providerAccepted).toBe(1);
    expect(store.accepted).toEqual([ROW_ID]);
    expect(resend.keyCalls).toEqual([ROW_ID, ROW_ID]);
    // The same email, under the same stable key, delivered twice: the second
    // copy is the duplicate the expired provider deduplication can no longer
    // suppress.
    expect(resend.deliveries).toEqual([
      { recipient: 'owner@example.com', idempotencyKey: ROW_ID },
      { recipient: 'owner@example.com', idempotencyKey: ROW_ID },
    ]);
    expect(resend.suppressed).toEqual([]);
  });
});
