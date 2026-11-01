import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseSpeakingV2ProviderError } from './speaking-v2-error.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-speaking');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

describe('parseSpeakingV2ProviderError', () => {
  it('maps captured unreadable audio without forwarding provider text', () => {
    const hint = parseSpeakingV2ProviderError(
      fixture('grading-v2-audio-unreadable.422.json'),
    );
    expect(hint).toEqual({
      code: 'AUDIO_UNREADABLE',
      message: 'Speaking audio could not be decoded',
      retryable: false,
    });
  });

  it('maps captured result-not-found to the stable public code', () => {
    expect(
      parseSpeakingV2ProviderError(fixture('grading-v2-not-found.404.json')),
    ).toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });

  it('does not guess an undocumented provider error code', () => {
    const body = fixture('grading-v2-audio-unreadable.422.json') as {
      error: { code: string };
    };
    body.error.code = 'unknown_aggregation_error';
    expect(parseSpeakingV2ProviderError(body)).toBeUndefined();
  });
});
