import { extractDownstreamTelemetry } from '../modules/metering/application/metering.telemetry';

describe('extractDownstreamTelemetry', () => {
  it('reads the additive internal usage envelope without touching business data', () => {
    expect(
      extractDownstreamTelemetry({
        data: { essay: 'private content' },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        models: [{ provider: 'provider-y', name: 'model-x' }],
        metrics: { ai_processing_ms: 70 },
      }),
    ).toEqual({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      models: [{ provider: 'provider-y', name: 'model-x' }],
      aiProcessingMs: 70,
    });
  });

  it('keeps valid partial usage and ignores malformed or untrusted fields', () => {
    expect(
      extractDownstreamTelemetry({
        usage: { input_tokens: 10, output_tokens: 'bad', total_tokens: -1 },
        models: [
          { provider: 'provider-y', name: 'model-x' },
          { provider: 7, name: 'ignored' },
        ],
        metrics: { ai_processing_ms: 'bad' },
      }),
    ).toEqual({
      usage: { inputTokens: 10 },
      models: [{ provider: 'provider-y', name: 'model-x' }],
    });
  });
});
