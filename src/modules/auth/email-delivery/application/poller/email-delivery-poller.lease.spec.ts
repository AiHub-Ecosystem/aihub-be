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
  harness,
  sealed,
  worstCaseBatchMs,
} from './email-delivery-poller.spec-support';

describe('EmailDeliveryPoller', () => {
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
      new FakeEmailSendRateLimiter(),
      new FakeEmailProviderOutageCircuit(),
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
});
