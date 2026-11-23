import { sample } from '@/common/observability/metrics/metric-sample.testing';

describe('aihub_auth_web_session_client_secret_failures_total', () => {
  it('exposes a zero sample and counts each failed guess', async () => {
    const { recordWebSessionClientSecretFailure } = await import(
      './web-session-client-secret-metric'
    );

    expect(
      await sample('aihub_auth_web_session_client_secret_failures_total'),
    ).toBe('0');

    recordWebSessionClientSecretFailure();
    recordWebSessionClientSecretFailure();

    expect(
      await sample('aihub_auth_web_session_client_secret_failures_total'),
    ).toBe('2');
  });
});
