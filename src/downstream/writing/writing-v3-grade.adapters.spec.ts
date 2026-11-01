import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  writingV3Task1GradeAdapter,
  writingV3Task2GradeAdapter,
} from './writing-v3-grade.adapters';
import { providerOrganizationId } from './writing-v3-organization-id';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), `test/fixtures/ai-writing/${name}`),
      'utf8',
    ),
  );
}

const context = createRequestContext({
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  receivedAt: new Date('2026-11-01T00:00:00.000Z'),
  deadlineMs: 125_000,
  organizationId: 'org_acme',
  apiKeyId: 'ak-dev',
  userId: 'learner_42',
  identityMode: 'signed_assertion',
  scopes: ['writing.grade'],
});

const IDENTITY_HEADERS = {
  'x-aihub-organization-id': providerOrganizationId('org_acme'),
  'x-aihub-user-id': 'learner_42',
  'x-aihub-user-identity-mode': 'signed_assertion',
};

describe('writingV3Task1GradeAdapter', () => {
  it('posts the v1 request fields to the v3 path with the identity headers and the UUID Organization ID', () => {
    const input = {
      question: 'The chart shows enrolment.',
      chart_type: 'Bar Chart' as const,
      essay: 'The chart illustrates.',
      image_url: 'https://s3.example.com/chart.png',
    };

    expect(writingV3Task1GradeAdapter.buildRequest(input, context)).toEqual({
      method: 'POST',
      path: '/v3/grading-feedback-task1',
      headers: IDENTITY_HEADERS,
      body: {
        question: 'The chart shows enrolment.',
        topic: 'Bar Chart',
        essay: 'The chart illustrates.',
        url: 'https://s3.example.com/chart.png',
      },
      contentType: 'application/json',
    });
  });

  it('never sends the AIHUB Organization ID itself', () => {
    const request = writingV3Task1GradeAdapter.buildRequest(
      {
        question: 'q',
        chart_type: 'Bar Chart',
        essay: 'e',
        image_url: 'https://s3.example.com/c.png',
      },
      context,
    );

    expect(JSON.stringify(request)).not.toContain('org_acme');
  });

  it('parses the captured v3 Task 1 response and names its operation', () => {
    expect(writingV3Task1GradeAdapter.operation).toBe('writing.v2.task1.grade');
    expect(writingV3Task1GradeAdapter.downstream).toBe('ai-writing');
    const parsed = writingV3Task1GradeAdapter.parseResponse({
      status: 200,
      headers: {},
      body: fixture('grade-v3-task1.response.json'),
    });

    expect(parsed.criteria[0]?.id).toBe('task_achievement');
  });

  it('reads provider failures through the v3 error adapter', () => {
    expect(writingV3Task1GradeAdapter.parseError?.(504, undefined)?.code).toBe(
      'AI_SERVICE_TIMEOUT',
    );
  });

  it('refuses to build a request without an Organization or user identity', () => {
    const withoutUser = createRequestContext({
      requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
      receivedAt: new Date('2026-11-01T00:00:00.000Z'),
      deadlineMs: 125_000,
      organizationId: 'org_acme',
      apiKeyId: 'ak-dev',
      identityMode: 'declared_id',
      scopes: ['writing.grade'],
    });

    expect(() =>
      writingV3Task1GradeAdapter.buildRequest(
        {
          question: 'q',
          chart_type: 'Bar Chart',
          essay: 'e',
          image_url: 'https://s3.example.com/c.png',
        },
        withoutUser,
      ),
    ).toThrow('User identity is required');
  });
});

describe('writingV3Task2GradeAdapter', () => {
  it('posts question, topic and essay with no image url', () => {
    expect(
      writingV3Task2GradeAdapter.buildRequest(
        { question: 'Discuss', topic: 'education', essay: 'An essay.' },
        context,
      ),
    ).toEqual({
      method: 'POST',
      path: '/v3/grading-feedback-task2',
      headers: IDENTITY_HEADERS,
      body: { question: 'Discuss', topic: 'education', essay: 'An essay.' },
      contentType: 'application/json',
    });
  });

  it('parses the captured v3 Task 2 response', () => {
    expect(writingV3Task2GradeAdapter.operation).toBe('writing.v2.task2.grade');
    const parsed = writingV3Task2GradeAdapter.parseResponse({
      status: 200,
      headers: {},
      body: fixture('grade-v3-task2.response.json'),
    });

    expect(parsed.criteria[0]?.id).toBe('task_response');
  });
});
