import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '../../common/errors/app-error';
import { createRequestContext } from '../../common/request-context/request-context.factory';
import type { Task1QuestionRequest } from '../../contracts/writing/task1';
import { task1QuestionAdapter } from './task1-question.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const context = createRequestContext({
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  receivedAt: new Date('2026-09-07T00:00:00.000Z'),
  deadlineMs: 10_000,
  organizationId: 'org-dev',
  apiKeyId: 'ak-dev',
  scopes: ['writing.question.generate'],
});

describe('task1QuestionAdapter', () => {
  it('maps the canonical chart_type to the Writing topic field', () => {
    const input: Task1QuestionRequest = { chart_type: 'Bar Chart' };

    expect(task1QuestionAdapter.buildRequest(input, context)).toEqual({
      method: 'POST',
      path: '/generate-question-task1',
      body: { topic: 'Bar Chart' },
      contentType: 'application/json',
    });
  });

  it('sends an empty JSON object when a random question is requested', () => {
    expect(task1QuestionAdapter.buildRequest({}, context).body).toEqual({});
  });

  it('parses the real nested data.data response into the public contract', () => {
    expect(
      task1QuestionAdapter.parseResponse({
        status: 200,
        headers: {},
        body: fixture('question-task1.response.json'),
      }),
    ).toEqual({
      question_id: '4a7c819d-46f2-42f7-a1af-ec5e7c61d31e',
      question:
        'The chart below shows the total number of minutes (in billions) of telephone calls in the UK, divided into three categories, from 1995-2002. Summarise the information by selecting a reporting the main features, and make comparisons where relevant.',
      chart_type: 'Bar Chart',
      image_url: 'https://s3.wispace.app/ielts-task1/ca95bd4ab522946d',
    });
  });

  it('rejects a response without the nested question payload', () => {
    expect(() =>
      task1QuestionAdapter.parseResponse({
        status: 200,
        headers: {},
        body: { data: {} },
      }),
    ).toThrow(AppError);
  });
});
