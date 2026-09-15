import {
  claimRequestMetering,
  elapsedRequestMs,
  getRequestMeteringState,
  initializeRequestMetering,
  setRequestMeteringIdentity,
  setRequestMeteringTelemetry,
} from './request-metering-state';

describe('request metering state', () => {
  it('keeps identity and dispatch telemetry together and can be claimed once', () => {
    const request = {};
    initializeRequestMetering(request, new Date('2026-09-15T00:00:00Z'), 0);
    setRequestMeteringIdentity(request, {
      operation: 'writing.task1.grade',
      organizationId: 'org_acme',
      apiKeyId: 'ak_backend',
      environment: 'production',
    });
    setRequestMeteringTelemetry(request, 'writing.task1.grade', {
      downstreamMs: 42,
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      idempotentReplay: true,
    });

    const state = getRequestMeteringState(request);
    expect(state).toEqual(
      expect.objectContaining({
        organizationId: 'org_acme',
        apiKeyId: 'ak_backend',
        downstreamMs: 42,
        idempotentReplay: true,
      }),
    );
    expect(
      elapsedRequestMs(state as NonNullable<typeof state>),
    ).toBeGreaterThanOrEqual(0);
    expect(claimRequestMetering(request)).toBe(state);
    expect(claimRequestMetering(request)).toBeUndefined();
  });
});
