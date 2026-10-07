import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractDownstreamTelemetry } from '@/modules/metering/application/metering.telemetry';

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

  it.each([
    {
      operation: 'Task 1',
      fixture: 'grade-task1.telemetry.capture.json',
      expected: {
        inputTokens: 72115,
        outputTokens: 5059,
        totalTokens: 77174,
        aiProcessingMs: 41063,
      },
    },
    {
      operation: 'Task 2',
      fixture: 'grade-task2.telemetry.capture.json',
      expected: {
        inputTokens: 75488,
        outputTokens: 6032,
        totalTokens: 81520,
        aiProcessingMs: 32463,
      },
    },
  ])(
    'normalizes the captured AI Writing $operation telemetry',
    ({ fixture, expected }) => {
      const response = JSON.parse(
        readFileSync(
          join(__dirname, '../../test/fixtures/ai-writing', fixture),
          'utf8',
        ),
      ) as unknown;

      expect(extractDownstreamTelemetry(response)).toEqual({
        usage: {
          inputTokens: expected.inputTokens,
          outputTokens: expected.outputTokens,
          totalTokens: expected.totalTokens,
        },
        aiProcessingMs: expected.aiProcessingMs,
      });
    },
  );

  it('normalizes telemetry from the AI Speaking production smoke', () => {
    const response = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../test/fixtures/ai-speaking/grading.telemetry.capture.json',
        ),
        'utf8',
      ),
    ) as unknown;

    expect(extractDownstreamTelemetry(response)).toEqual({
      usage: { inputTokens: 1133, outputTokens: 994, totalTokens: 2127 },
      aiProcessingMs: 8329,
    });
  });
});
