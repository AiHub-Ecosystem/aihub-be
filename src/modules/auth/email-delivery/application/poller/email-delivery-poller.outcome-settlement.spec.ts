import {
  FakeEmailProviderOutageCircuit,
  NOW,
  ROW_ID,
  RecordingSender,
  claimed,
  harness,
} from './email-delivery-poller.spec-support';

function clock(): { now: () => Date; advanceMs: (ms: number) => void } {
  let currentMs = NOW.getTime();
  return {
    now: () => new Date(currentMs),
    advanceMs: (ms) => {
      currentMs += ms;
    },
  };
}

describe('EmailDeliveryPoller circuit bookkeeping (#441)', () => {
  it('tells the circuit which failure count and probe the successful send held', async () => {
    const outageCircuit = new FakeEmailProviderOutageCircuit();
    outageCircuit.permit = {
      allowed: true,
      probeToken: 'probe-1',
      generation: 4,
    };
    const { poller, store } = harness({ outageCircuit });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(outageCircuit.reachableSent).toEqual([
      { generation: 4, probeToken: 'probe-1' },
    ]);
  });

  it('measures the local fallback from a clock read after the failed write', async () => {
    const { now, advanceMs } = clock();
    const outageCircuit = new FakeEmailProviderOutageCircuit();
    outageCircuit.recordFailureError = new Error('redis unavailable');
    // The write and the probe release take longer than the fallback delay.
    outageCircuit.beforeFailure = () => advanceMs(20_000);
    const sender = new RecordingSender();
    sender.response = { status: 503, retryAfter: undefined };
    const { poller, store } = harness({ sender, outageCircuit, now });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.unspent.map(({ retryAt }) => retryAt)).toEqual([
      new Date(NOW.getTime() + 20_000 + 5_000),
    ]);
  });

  it('keeps a later Retry-After deadline when the shared write fails', async () => {
    const { now } = clock();
    const outageCircuit = new FakeEmailProviderOutageCircuit();
    outageCircuit.recordFailureError = new Error('redis unavailable');
    const sender = new RecordingSender();
    sender.response = { status: 429, retryAfter: '60' };
    const { poller, store } = harness({ sender, outageCircuit, now });
    store.claimResult = [claimed()];

    await poller.runOnce();

    expect(store.unspent.map(({ retryAt }) => retryAt)).toEqual([
      new Date(NOW.getTime() + 60_000),
    ]);
  });

  it('holds the rest of a batch while a pause opened by an earlier row lasts', async () => {
    const outageCircuit = new FakeEmailProviderOutageCircuit();
    // The first row is accepted, but the circuit cannot record that.
    outageCircuit.recordReachableError = new Error('redis unavailable');
    const { poller, store, sender } = harness({ outageCircuit });
    store.claimResult = [
      claimed({ id: 'edr_01J00000000000000000000001' }),
      claimed({ id: 'edr_01J00000000000000000000002' }),
    ];

    const summary = await poller.runOnce();

    expect(summary.providerAccepted).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(sender.sends).toHaveLength(1);
  });
});

describe('EmailDeliveryPoller conflict whose terminal write is rejected (#441)', () => {
  function conflicting(): ReturnType<typeof harness> {
    const sender = new RecordingSender();
    sender.response = {
      status: 409,
      retryAfter: undefined,
      idempotencyConflict: 'payload_changed',
    };
    const built = harness({ sender });
    built.store.claimResult = [claimed()];
    return built;
  }

  it('settles the request before any claim, and never sends it again', async () => {
    const { poller, store, sender } = conflicting();
    store.failMarkFailed = 2;

    await poller.runOnce();
    expect(store.failed).toEqual([]);
    expect(sender.sends).toHaveLength(1);

    // The write is still rejected: no claim starts, so nothing is sent again.
    store.claims = [];
    await poller.runOnce();
    expect(store.failed).toEqual([]);
    expect(store.claims).toEqual([]);
    expect(sender.sends).toHaveLength(1);

    // Once the store answers, the outcome is recorded before anything is claimed.
    store.claimResult = [];
    await poller.runOnce();
    expect(store.failed).toEqual([
      { id: ROW_ID, errorCode: 'outcome_unknown' },
    ]);
    expect(sender.sends).toHaveLength(1);
  });

  it('records the outcome before the stale sweep can cancel the row', async () => {
    const { poller, store } = conflicting();
    store.failMarkFailed = 1;
    const order: string[] = [];
    const markFailed = store.markFailed.bind(store);
    store.markFailed = async (input) => {
      await markFailed(input);
      order.push('failed');
    };
    const cancelStale = store.cancelStale.bind(store);
    store.cancelStale = async (input) => {
      order.push('stale');
      return cancelStale(input);
    };

    await poller.runOnce();
    order.length = 0;
    store.claimResult = [];
    await poller.runOnce();

    expect(order[0]).toBe('failed');
    expect(order).toContain('stale');
  });
});
