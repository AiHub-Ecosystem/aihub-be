import type { EmailSendRateReservation } from '@/modules/auth/email-delivery/application/email-send-rate-limiter.port';
import {
  FakeEmailSendRateLimiter,
  NOW,
  ROW_ID,
  RecordingSender,
  claimed,
  harness,
} from '../../../../../../test/support/auth/email-delivery-poller.spec-support';

/** A slow limiter: the clock moves on while the reservation is in flight. */
class SlowRateLimiter extends FakeEmailSendRateLimiter {
  constructor(
    private readonly advanceMs: (ms: number) => void,
    private readonly delayMs: number,
    reservation: EmailSendRateReservation,
  ) {
    super();
    this.result = reservation;
  }

  override async reserve(): Promise<EmailSendRateReservation> {
    this.advanceMs(this.delayMs);
    return super.reserve();
  }
}

function clock(): { now: () => Date; advanceMs: (ms: number) => void } {
  let currentMs = NOW.getTime();
  return {
    now: () => new Date(currentMs),
    advanceMs: (ms) => {
      currentMs += ms;
    },
  };
}

// The claim makes a row with one failed attempt eligible one minute after
// `last_attempt_at`; a preflight longer than that must not use the minute up.
const PREFLIGHT_MS = 2 * 60_000;

describe('EmailDeliveryPoller backoff after a slow preflight (#441)', () => {
  it('records a failed attempt at the provider result, not at the start of the pass', async () => {
    const { now, advanceMs } = clock();
    const sender = new RecordingSender();
    sender.response = { status: 418, retryAfter: undefined };
    const { poller, store } = harness({
      sender,
      now,
      rateLimiter: new SlowRateLimiter(advanceMs, PREFLIGHT_MS, {
        reserved: true,
      }),
    });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.attempts).toEqual([
      { id: ROW_ID, errorCode: 'provider_rejected' },
    ]);
    expect(store.failedAttemptTimes).toEqual([
      new Date(NOW.getTime() + PREFLIGHT_MS),
    ]);
  });

  it('holds a limiter denial for its full wait after the denial arrives', async () => {
    const { now, advanceMs } = clock();
    const { poller, store } = harness({
      now,
      rateLimiter: new SlowRateLimiter(advanceMs, PREFLIGHT_MS, {
        reserved: false,
        retryAfterMs: 30_000,
      }),
    });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.deferredUntil).toEqual([
      new Date(NOW.getTime() + PREFLIGHT_MS + 30_000),
    ]);
    // Another pass just before that instant finds nothing to claim.
    advanceMs(30_000 - 1);
    store.claims = [];
    const early = await poller.runOnce();
    expect(early.claimed).toBe(0);
  });
});
