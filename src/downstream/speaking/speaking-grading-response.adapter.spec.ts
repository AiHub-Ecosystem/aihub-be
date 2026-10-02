import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '@/common/errors/app-error';

import { parseSpeakingGradeResponse } from './speaking-grading-response.adapter';

const FIXTURE = join(
  __dirname,
  '../../../test/fixtures/ai-speaking/grading.response.json',
);

type Json = Record<string, unknown>;

function providerResponse(): { status: string; data: Json } {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function violation(
  mutate: (body: { status: string; data: Json }) => void,
): AppError {
  const body = providerResponse();
  mutate(body);
  let caught: unknown;
  try {
    parseSpeakingGradeResponse(body);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AppError)) {
    throw new Error('expected the response to be refused');
  }
  return caught;
}

function firstSyllable(body: { data: Json }): Json {
  const detail = body.data.pronunciation_detail as { words: Json[] };
  const word = detail.words[0] as { syllables: Json[] };
  return word.syllables[0] as Json;
}

describe('parseSpeakingGradeResponse', () => {
  it('accepts the captured provider response', () => {
    expect(() => parseSpeakingGradeResponse(providerResponse())).not.toThrow();
  });

  describe('a contract violation says where, never what', () => {
    it('names the field that broke the schema and the kind of mismatch', () => {
      const error = violation((body) => {
        firstSyllable(body).predicted_stress = null;
      });

      expect(error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
      expect(error.diagnostic).toContain(
        '/pronunciation_detail/words/0/syllables/0/predicted_stress (Integer)',
      );
    });

    it('names an unexpected key without echoing its value', () => {
      const secret = 'private provider value';
      const error = violation((body) => {
        firstSyllable(body).unexpected_field = secret;
      });

      expect(error.diagnostic).toContain(
        '/pronunciation_detail/words/0/syllables/0/unexpected_field',
      );
      expect(error.diagnostic).not.toContain(secret);
    });

    it('never carries the transcript or any other value from the response', () => {
      const body = providerResponse();
      const transcript = String(
        (body.data.transcript as { text: string }).text,
      );
      const error = violation((mutated) => {
        firstSyllable(mutated).predicted_stress = 'not a number';
        (mutated.data.transcript as { text: string }).text = transcript;
      });

      expect(error.diagnostic).not.toContain(transcript);
      expect(error.diagnostic).not.toContain('not a number');
    });

    it('lists at most three failures and keeps the line short', () => {
      const error = violation((body) => {
        const detail = body.data.pronunciation_detail as { words: Json[] };
        for (const word of detail.words) {
          for (const syllable of word.syllables as Json[]) {
            syllable.predicted_stress = null;
          }
        }
      });

      const paths = (error.diagnostic ?? '').split('; ');
      expect(paths).toHaveLength(3);
      expect(error.diagnostic?.length).toBeLessThanOrEqual(400);
    });

    it('names the missing group when a required group is absent', () => {
      const error = violation((body) => {
        body.data.feedback = undefined;
      });

      expect(error.diagnostic).toBe('missing object group feedback');
    });

    it('names a collection that is not one', () => {
      const error = violation((body) => {
        (body.data.language_analysis as Json).grammar_errors = 'none';
      });

      expect(error.diagnostic).toBe(
        'field language_analysis.grammar_errors is not a collection',
      );
    });

    it('keeps the public message generic', () => {
      const error = violation((body) => {
        firstSyllable(body).predicted_stress = null;
      });

      expect(error.message).toBe(
        'AI service returned an unexpected response shape',
      );
      expect(JSON.stringify(error.toEnvelope('req_1'))).not.toContain(
        'predicted_stress',
      );
    });
  });
});
