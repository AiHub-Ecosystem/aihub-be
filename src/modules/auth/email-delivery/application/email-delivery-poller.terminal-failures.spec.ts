import {
  NOW,
  ROW_ID,
  TOKEN,
  VERIFICATION_PAYLOAD,
  claimed,
  harness,
} from './email-delivery-poller.spec-support';

describe('terminal failure reporting', () => {
  it('reports a request that used its last attempt', async () => {
    const failures: unknown[] = [];
    const { poller, store, sender } = harness({
      payload: {
        ...VERIFICATION_PAYLOAD,
        organizationName: 'Resonance',
        role: 'member',
      },
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
