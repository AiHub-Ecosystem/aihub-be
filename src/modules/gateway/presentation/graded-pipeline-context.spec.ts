import type { FastifyReply } from 'fastify';

import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { createGradedPipelineContext } from './graded-pipeline-context';

describe('createGradedPipelineContext', () => {
  it('fails closed when the catalog operation does not match the route', () => {
    const request = {
      routeOptions: { url: '/v1/unrelated' },
    } as unknown as AuthenticatedRequest;

    expect(() =>
      createGradedPipelineContext(
        request,
        {} as FastifyReply,
        'writing.task1.grade',
        async () => ({ input: {} as never }),
      ),
    ).toThrow('Graded admission is not wired for this route');
  });

  it('fails closed when the route has no graded metering evidence', () => {
    const request = {
      routeOptions: { url: '/v1/ielts/writing/task1/grade' },
    } as unknown as AuthenticatedRequest;

    expect(() =>
      createGradedPipelineContext(
        request,
        {} as FastifyReply,
        'writing.task1.grade',
        async () => ({ input: {} as never }),
      ),
    ).toThrow('Graded admission is not wired for this route');
  });
});
