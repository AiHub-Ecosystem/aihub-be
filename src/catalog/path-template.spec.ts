import { matchesPathTemplate } from './path-template';

describe('matchesPathTemplate', () => {
  it('matches public braces and Fastify colon parameters', () => {
    expect(
      matchesPathTemplate(
        '/v2/ielts/speaking/responses/{response_id}',
        '/v2/ielts/speaking/responses/:response_id',
      ),
    ).toBe(true);
    expect(
      matchesPathTemplate(
        '/v2/ielts/speaking/responses/{response_id}',
        '/v2/ielts/speaking/responses/resp_123',
      ),
    ).toBe(true);
  });

  it('keeps static path segments exact', () => {
    expect(
      matchesPathTemplate('/v1/ielts/writing/grade', '/v1/xwriting/grade'),
    ).toBe(false);
  });
});
