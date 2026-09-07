import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '../../common/errors/app-error';
import { createRequestContext } from '../../common/request-context/request-context.factory';
import type { Task2QuestionRequest } from '../../contracts/writing/task2';
import { task2QuestionAdapter } from './task2-question.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const context = createRequestContext({
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  receivedAt: new Date('2026-09-07T00:00:00.000Z'),
  deadlineMs: 30_000,
  organizationId: 'org-dev',
  apiKeyId: 'ak-dev',
  scopes: ['writing.question.generate'],
});

describe('task2QuestionAdapter', () => {
  it('sends the topic and question_type as-is, unlike task 1 which renames chart_type', () => {
    const input: Task2QuestionRequest = {
      topic: 'education',
      question_type: 'opinion',
    };

    expect(task2QuestionAdapter.buildRequest(input, context)).toEqual({
      method: 'POST',
      path: '/question-generated-task2',
      body: { topic: 'education', question_type: 'opinion' },
      contentType: 'application/json',
    });
  });

  it("parses the real flat response, distinct from task 1's nested data.data", () => {
    expect(
      task2QuestionAdapter.parseResponse({
        status: 200,
        headers: {},
        body: fixture('question-task2.response.json'),
      }),
    ).toEqual({
      question:
        'With the rise of online learning platforms, some argue that traditional classroom education is becoming obsolete. To what extent do you agree or disagree?',
      topic: '',
      question_type: 'opinion',
    });
  });

  it('rejects a response missing the description or instruction field', () => {
    expect(() =>
      task2QuestionAdapter.parseResponse({
        status: 200,
        headers: {},
        body: { data: {} },
      }),
    ).toThrow(AppError);
  });
});
