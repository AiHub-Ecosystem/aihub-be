import { createRequestContext } from '../../common/request-context/request-context.factory';
import type { GradeTask1Request } from '../../contracts/writing/grading';
import { task1GradeRequestAdapter } from './task1-grade-request.adapter';

describe('task1GradeRequestAdapter', () => {
  it('renames image_url to url and chart_type to topic without identity fields', () => {
    const input: GradeTask1Request = {
      question: 'Describe the chart',
      image_url: 'https://example.com/chart.png',
      chart_type: 'Bar Chart',
      essay: 'A long enough essay.',
    };
    const originalInput = structuredClone(input);
    const context = createRequestContext({
      requestId: 'req-123',
      receivedAt: new Date('2026-09-07T00:00:00.000Z'),
      deadlineMs: 60_000,
      organizationId: 'org-123',
      userId: 'user-123',
      scopes: ['writing:grade'],
    });

    const result = task1GradeRequestAdapter.buildRequest(input, context);

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
});
