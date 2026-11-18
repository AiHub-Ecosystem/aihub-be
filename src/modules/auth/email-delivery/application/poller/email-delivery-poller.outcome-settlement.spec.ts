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
    // The rejected writes did not land: the row is still queued.
    store.dispatchState = {
      status: 'queued',
      attempts: 1,
      lastAttemptAt: NOW,
      leaseExpiresAt: null,
    };

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

  it('drops a pending outcome once the row is already terminal', async () => {
    const { poller, store } = conflicting();
    // The write committed but answered with an error, then kept failing.
    store.failMarkFailed = 2;
    store.dispatchState = {
      status: 'queued',
      attempts: 1,
      lastAttemptAt: NOW,
      leaseExpiresAt: null,
    };
    await poller.runOnce();

    store.dispatchState = { ...store.dispatchState, status: 'failed' };
    store.claims = [];
    store.claimResult = [];
    await poller.runOnce();

    // Nothing is left to settle, so claiming resumes.
    expect(store.claims).toHaveLength(1);
  });

  it('keeps the pending outcome while the row is still queued', async () => {
    const { poller, store } = conflicting();
    store.failMarkFailed = 2;
    store.dispatchState = {
      status: 'queued',
      attempts: 1,
      lastAttemptAt: NOW,
      leaseExpiresAt: null,
    };
    await poller.runOnce();
    store.claims = [];
    await poller.runOnce();

    expect(store.claims).toEqual([]);
  });

  it('leaves the conflict row failed, not cancelled, when it is also stale', async () => {
    const { poller, store } = conflicting();
    // One stateful row that both the terminal write and the stale sweep act on.
    let status: 'queued' | 'failed' | 'cancelled' = 'queued';
    let rejections = 1;
    const row = claimed();
    store.markFailed = async () => {
      if (rejections > 0) {
        rejections -= 1;
        throw new Error('the outbox store is unavailable');
      }
      if (status === 'queued') status = 'failed';
    };
    const cancelStale = store.cancelStale.bind(store);
    store.cancelStale = async (input) => {
      const rows = await cancelStale(input);
      if (rows.length === 0 || status !== 'queued') return [];
      status = 'cancelled';
      return rows;
    };

    await poller.runOnce();
    expect(status).toBe('queued');
    // The row has since aged past its stale cutoff.
    store.stale = [row];
    store.claimResult = [];
    await poller.runOnce();

    expect(status).toBe('failed');
  });
});
