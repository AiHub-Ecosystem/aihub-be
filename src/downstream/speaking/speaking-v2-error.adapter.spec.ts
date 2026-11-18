import { fixtureJson } from '../../../test/support/json-fixtures';
import { parseSpeakingV2ProviderError } from './speaking-v2-error.adapter';

describe('parseSpeakingV2ProviderError', () => {
  it('maps captured unreadable audio without forwarding provider text', () => {
    const hint = parseSpeakingV2ProviderError(
      fixtureJson('ai-speaking', 'grading-v2-audio-unreadable.422.json'),
    );
    expect(hint).toEqual({
      code: 'AUDIO_UNREADABLE',
      message: 'Speaking audio could not be decoded',
      retryable: false,
    });
  });

  it('maps captured result-not-found to the stable public code', () => {
    expect(
      parseSpeakingV2ProviderError(
        fixtureJson('ai-speaking', 'grading-v2-not-found.404.json'),
      ),
    ).toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });

  it('keeps captured aggregation 422 on the dispatcher generic fallback', () => {
    expect(
      parseSpeakingV2ProviderError(
        fixtureJson('ai-speaking', 'grading-v2-test-mixed-tests.422.json'),
      ),
    ).toBeUndefined();
  });

  it('does not guess an undocumented provider error code', () => {
    const body = fixtureJson(
      'ai-speaking',
      'grading-v2-audio-unreadable.422.json',
    ) as {
      error: { code: string };
    };
    body.error.code = 'unknown_aggregation_error';
    expect(parseSpeakingV2ProviderError(body)).toBeUndefined();
  });
});
