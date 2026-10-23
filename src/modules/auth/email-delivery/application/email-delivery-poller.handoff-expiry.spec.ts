import {
  FakeEmailProviderOutageCircuit,
  FakeEmailSendRateLimiter,
  ROW_ID,
  VERIFICATION_PAYLOAD,
  claimed,
  harness,
} from './email-delivery-poller.spec-support';

const EXPIRES_AT = Date.parse(VERIFICATION_PAYLOAD.expiresAt);
const ENTRY_MS = EXPIRES_AT - 1_000;

type PreflightWait =
  | 'rate reservation'
  | 'daily budget'
  | 'attempt reservation';

/**
 * Runs one request that is valid at dispatch entry and whose clock moves
 * `elapsedMs` while it waits on `wait`, the way a slow Redis or Postgres would.
 */
async function dispatchWaiting(wait: PreflightWait, elapsedMs: number) {
  let current = ENTRY_MS;
  const advance = async (): Promise<void> => {
    current += elapsedMs;
  };
  const outageCircuit = new FakeEmailProviderOutageCircuit();
  outageCircuit.permit = { allowed: true, probeToken: 'probe-1' };
  const rateLimiter = new FakeEmailSendRateLimiter();
  if (wait === 'rate reservation') {
    rateLimiter.reserve = async () => {
      await advance();
      return { reserved: true };
    };
  }
  const { poller, store, sender } = harness({
    now: () => new Date(current),
    outageCircuit,
    rateLimiter,
    ...(wait === 'daily budget'
      ? {
          dailySendBudget: {
            reserve: async () => {
              await advance();
              return { reserved: true as const };
            },
            usage: async () => ({ used: 0, limit: 10 }),
          },
        }
      : {}),
  });
  if (wait === 'attempt reservation') {
    store.reserveAttempt = async (input) => {
      store.reserved.push(input.id);
      await advance();
    };
  }
  store.claimResult = [claimed()];
  const summary = await poller.runOnce();
  return { summary, store, sender, outageCircuit };
}

describe('EmailDeliveryPoller credential expiry during preflight', () => {
  it.each<PreflightWait>([
    'rate reservation',
    'daily budget',
    'attempt reservation',
  ])(
    'cancels a credential that expires while waiting for the %s',
    async (wait) => {
      const { summary, store, sender, outageCircuit } = await dispatchWaiting(
        wait,
        2_000,
      );

      expect(sender.sends).toEqual([]);
      expect(store.cancelled).toEqual([
        { id: ROW_ID, reason: 'credential_expired' },
      ]);
      expect(store.failed).toEqual([]);
      expect(summary).toMatchObject({ cancelled: 1, providerAccepted: 0 });
      expect(outageCircuit.releases).toEqual(['probe-1']);
    },
  );

  it('cancels a credential whose deadline is reached exactly at handoff', async () => {
    const { store, sender } = await dispatchWaiting('rate reservation', 1_000);

    expect(sender.sends).toEqual([]);
    expect(store.cancelled[0]?.reason).toBe('credential_expired');
  });

  it('still sends a credential that is valid at handoff', async () => {
    const { summary, store, sender } = await dispatchWaiting(
      'rate reservation',
      999,
    );

    expect(sender.sends).toHaveLength(1);
    expect(store.cancelled).toEqual([]);
    expect(summary.providerAccepted).toBe(1);
  });
});
