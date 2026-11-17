import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  MODEL_QUOTE_MAX_LENGTH,
  MODEL_TEXT_MAX_LENGTH,
} from '@/contracts/model-text';
import { parseSpeakingGradeResponse } from './speaking/speaking-grading-response.adapter';
import { parseSpeakingV2QuestionResult } from './speaking/speaking-v2-question-response.adapter';
import { parseGradeResponse } from './writing/grade-response.adapter';
import { createMicroExerciseAdapter } from './writing/writing-micro-exercises.adapters';
import { parseWritingV3Response } from './writing/writing-v3-response.adapter';

const BIDI_OVERRIDE = String.fromCodePoint(0x202e);

type Path = readonly (string | number)[];

interface Adapter {
  readonly name: string;
  readonly fixture: string;
  /** A model-generated sentence in the provider body. */
  readonly text: Path;
  readonly parse: (body: unknown) => unknown;
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: 'Writing v1 grading',
    fixture: 'ai-writing/grade-task1.response.json',
    text: ['data', 'evaluation', '1_task_achievement', 'band_reason'],
    parse: parseGradeResponse,
  },
  {
    name: 'Writing v3 grading',
    fixture: 'ai-writing/grade-v3-task1.response.json',
    text: ['data', 'evaluation', '1_task_achievement', 'band_reason'],
    parse: parseWritingV3Response,
  },
  {
    name: 'Writing micro exercise',
    fixture: 'ai-writing/micro-reorder.response.json',
    text: ['data', 'exercise', 0, 'explanation'],
    parse: (body) =>
      createMicroExerciseAdapter.parseResponse({
        status: 200,
        headers: {},
        body,
      }),
  },
  {
    name: 'Speaking v1 grading',
    fixture: 'ai-speaking/grading.response.json',
    text: ['data', 'feedback', 'summary_vi'],
    parse: parseSpeakingGradeResponse,
  },
  {
    name: 'Speaking v2 question result',
    fixture: 'ai-speaking/grading-v2-question-post.200.json',
    text: ['data', 'overall_feedback', 'overview_vi'],
    parse: parseSpeakingV2QuestionResult,
  },
];

function step(node: unknown, key: string | number): unknown {
  if (Array.isArray(node) && typeof key === 'number') return node[key];
  if (isRecord(node) && typeof key === 'string') return node[key];
  throw new Error(`the fixture has no ${String(key)}`);
}

function bodyWith(fixture: string, path: Path, value: string): unknown {
  const body: unknown = JSON.parse(
    readFileSync(join(__dirname, '../../test/fixtures', fixture), 'utf8'),
  );
  const last = path.at(-1);
  let parent = body;
  for (const key of path.slice(0, -1)) parent = step(parent, key);
  if (Array.isArray(parent) && typeof last === 'number') {
    parent[last] = value;
  } else if (isRecord(parent) && typeof last === 'string') {
    parent[last] = value;
  } else {
    throw new Error('the fixture has no field to replace');
  }
  return body;
}

function refusal(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the response to be refused');
}

describe.each(ADAPTERS)('$name model-generated text (#377)', (adapter) => {
  it('drops control characters and keeps the surrounding text', () => {
    const result = JSON.stringify(
      adapter.parse(
        bodyWith(
          adapter.fixture,
          adapter.text,
          'before\u0000\u0007\u001b[31m\u007f\u0085' +
            BIDI_OVERRIDE +
            'after\n\tkept',
        ),
      ),
    );

    expect(result).toContain('before[31mafter\\n\\tkept');
    expect(result).not.toMatch(/\\u00(?:00|07|1b|7f|85)/);
    expect(result).not.toContain(BIDI_OVERRIDE);
  });

  it('accepts text of exactly the maximum length', () => {
    const text = 'x'.repeat(MODEL_TEXT_MAX_LENGTH);

    expect(() =>
      adapter.parse(bodyWith(adapter.fixture, adapter.text, text)),
    ).not.toThrow();
  });

  it('refuses longer text as a contract violation without echoing it', () => {
    const error = refusal(() =>
      adapter.parse(
        bodyWith(
          adapter.fixture,
          adapter.text,
          'x'.repeat(MODEL_TEXT_MAX_LENGTH + 1),
        ),
      ),
    );

    expect(error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
    expect(`${error.message} ${error.diagnostic}`).not.toContain('xxxx');
  });
});

describe('a quoted or transcribed passage (#377)', () => {
  const transcript = [
    'ai-speaking/grading.response.json',
    ['data', 'transcript', 'text'],
  ] as const;

  it('may be as long as the longest essay AIHUB accepts', () => {
    expect(() =>
      parseSpeakingGradeResponse(
        bodyWith(...transcript, 'x'.repeat(MODEL_QUOTE_MAX_LENGTH)),
      ),
    ).not.toThrow();
  });

  it('is refused beyond that', () => {
    const error = refusal(() =>
      parseSpeakingGradeResponse(
        bodyWith(...transcript, 'x'.repeat(MODEL_QUOTE_MAX_LENGTH + 1)),
      ),
    );

    expect(error.code).toBe('AI_SERVICE_CONTRACT_VIOLATION');
  });
});
