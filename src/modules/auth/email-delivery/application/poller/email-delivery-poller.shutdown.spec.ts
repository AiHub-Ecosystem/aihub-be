import { EmailDeliveryPoller } from './email-delivery-poller';
import {
  FakeCredentials,
  FakeEmailProviderOutageCircuit,
  FakeEmailSendRateLimiter,
  FakeStore,
  NOW,
  RecordingSender,
  TOKEN_HASH,
  VERIFICATION_PAYLOAD,
  claimed,
  sealed,
} from './email-delivery-poller.spec-support';

function pollerStoppedBy(
  shouldStop: () => boolean,
  store: FakeStore,
  sender: RecordingSender,
): EmailDeliveryPoller {
  return new EmailDeliveryPoller(
    store,
    new FakeCredentials(),
    sealed(VERIFICATION_PAYLOAD),
    sender,
    new FakeEmailSendRateLimiter(),
    new FakeEmailProviderOutageCircuit(),
    (): Date => NOW,
    { hash: () => TOKEN_HASH },
    { owner: 'instance-a', shouldStop },
  );
}

describe('EmailDeliveryPoller during shutdown', () => {
  it('claims nothing and calls no provider once shutdown has begun', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    store.claimResult = [claimed({ id: 'edr_a' })];

    const summary = await pollerStoppedBy(() => true, store, sender).runOnce();

    expect(store.claims).toEqual([]);
    expect(sender.sends).toEqual([]);
    expect(summary).toMatchObject({ claimed: 0, providerAccepted: 0 });
  });

  it('finishes the request in flight, then hands the rest of the batch back without an attempt', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    store.claimResult = [
      claimed({ id: 'edr_first' }),
      claimed({ id: 'edr_second' }),
      claimed({ id: 'edr_third' }),
    ];
    // Shutdown begins while the first request is with the provider.
    let stopping = false;
    const send = sender.send.bind(sender);
    sender.send = async (...args) => {
      stopping = true;
      return send(...args);
    };

    const summary = await pollerStoppedBy(
      () => stopping,
      store,
      sender,
    ).runOnce();

    expect(sender.sends).toHaveLength(1);
    expect(store.accepted).toEqual(['edr_first']);
    expect(store.deferred).toEqual(['edr_second', 'edr_third']);
    expect(store.reserved).toEqual(['edr_first']);
    expect(summary).toMatchObject({ providerAccepted: 1, deferred: 2 });
  });

  it('runs a whole batch when shutdown never begins', async () => {
    const store = new FakeStore();
    const sender = new RecordingSender();
    store.claimResult = [claimed({ id: 'edr_a' }), claimed({ id: 'edr_b' })];

    await pollerStoppedBy(() => false, store, sender).runOnce();

    expect(store.accepted).toEqual(['edr_a', 'edr_b']);
    expect(store.deferred).toEqual([]);
  });
});
