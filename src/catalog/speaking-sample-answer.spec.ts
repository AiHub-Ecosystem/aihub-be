import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SPEAKING_SAMPLE_ANSWER } from '../modules/speaking/application/speaking-question-catalog';

const REPO_ROOT = join(__dirname, '../..');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findPostmanItem(
  value: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPostmanItem(item, name);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return value.name === name ? value : findPostmanItem(value.item, name);
}

describe('Speaking sample answer artifacts', () => {
  it('uses one unsigned stable URL with the selected question metadata', () => {
    expect(SPEAKING_SAMPLE_ANSWER).toEqual({
      audioUrl:
        'https://s3.wispace.app/ielts-task1/speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm',
      part: 1,
      questionId: 'p1_do-you-enjoy-living-in-your-city-or-hometown',
      promptText: 'Do you enjoy living in your city or hometown?',
    });
    expect(new URL(SPEAKING_SAMPLE_ANSWER.audioUrl).search).toBe('');
  });

  it('keeps the Postman and integration-guide examples aligned', () => {
    const guide = readFileSync(
      join(REPO_ROOT, 'docs/integration-guide.md'),
      'utf8',
    );
    expect(guide).toContain(SPEAKING_SAMPLE_ANSWER.audioUrl);
    expect(guide).toContain(SPEAKING_SAMPLE_ANSWER.questionId);
    expect(guide).toContain(SPEAKING_SAMPLE_ANSWER.promptText);
    expect(guide).toContain('"part": 1');

    const collection = JSON.parse(
      readFileSync(join(REPO_ROOT, 'aihub.postman_collection.json'), 'utf8'),
    ) as unknown;
    const scenario = findPostmanItem(
      collection,
      'Grade the published Speaking sample answer',
    );
    const request = scenario?.request;
    const body = isRecord(request) ? request.body : undefined;
    const rawBody = isRecord(body) ? body.raw : undefined;

    if (typeof rawBody !== 'string') {
      throw new Error('Postman sample-answer request body is missing');
    }
    expect(JSON.parse(rawBody)).toEqual({
      audio_url: SPEAKING_SAMPLE_ANSWER.audioUrl,
      part: SPEAKING_SAMPLE_ANSWER.part,
      question_id: SPEAKING_SAMPLE_ANSWER.questionId,
      prompt_text: SPEAKING_SAMPLE_ANSWER.promptText,
      test_type: 'Practice',
    });
  });
});
