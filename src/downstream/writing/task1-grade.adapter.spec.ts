import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { GradeTask1Request } from '@/contracts/writing/grading';
import { task1GradeAdapter } from './task1-grade.adapter';

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

describe('task1GradeAdapter', () => {
  it('renames image_url to url and chart_type to topic without leaking identity fields', () => {
    const input: GradeTask1Request = {
      question: 'Describe the chart',
      image_url: 'https://example.com/chart.png',
      chart_type: 'Bar Chart',
      essay: 'A long enough essay.',
    };
    const originalInput = structuredClone(input);

    const result = task1GradeAdapter.buildRequest(input, context);

    expect(result).toEqual({
      method: 'POST',
      path: '/grading-feedback-task1',
      body: {
        question: 'Describe the chart',
        url: 'https://example.com/chart.png',
        topic: 'Bar Chart',
        essay: 'A long enough essay.',
      },
      contentType: 'application/json',
    });
    expect(input).toEqual(originalInput);
    expect(result.body).not.toHaveProperty('organizationId');
    expect(result.body).not.toHaveProperty('userId');
  });

  it('delegates response parsing to the shared grading parser on the real fixture', () => {
    const result = task1GradeAdapter.parseResponse({
      status: 200,
      headers: {},
      body: fixture('grade-task1.response.json'),
    });

    expect(result.overall_band).toBe(7);
    expect(result.criteria[0]?.id).toBe('task_achievement');
  });
});
