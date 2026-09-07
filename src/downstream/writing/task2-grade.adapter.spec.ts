import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRequestContext } from '../../common/request-context/request-context.factory';
import type { GradeTask2Request } from '../../contracts/writing/grading';
import { task2GradeAdapter } from './task2-grade.adapter';

const FIXTURES = join(__dirname, '../../../test/fixtures/ai-writing');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const context = createRequestContext({
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  receivedAt: new Date('2026-09-07T00:00:00.000Z'),
  deadlineMs: 60_000,
  organizationId: 'org-dev',
  apiKeyId: 'ak-dev',
  userId: 'user-dev',
  scopes: ['writing.grade'],
});

describe('task2GradeAdapter', () => {
  it('forwards question, topic, and essay without an image url, unlike task 1', () => {
    const input: GradeTask2Request = {
      question: 'Discuss remote work',
      topic: 'education',
      essay: 'A long enough essay.',
    };
    const originalInput = structuredClone(input);

    const result = task2GradeAdapter.buildRequest(input, context);

    expect(result).toEqual({
      method: 'POST',
      path: '/grading-feedback-task2',
      body: {
        question: 'Discuss remote work',
        topic: 'education',
        essay: 'A long enough essay.',
      },
      contentType: 'application/json',
    });
    expect(input).toEqual(originalInput);
    expect(result.body).not.toHaveProperty('image_url');
    expect(result.body).not.toHaveProperty('url');
  });

  it('delegates response parsing to the shared grading parser, using the task_response criterion', () => {
    const result = task2GradeAdapter.parseResponse({
      status: 200,
      headers: {},
      body: fixture('grade-task2.response.json'),
    });

    expect(result.criteria[0]?.id).toBe('task_response');
  });
});
