import { MockAgent } from 'undici';

import type { OperationId } from '@/catalog/operation-id';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { DownstreamHttpClient } from './downstream-http.client';
import { HttpOperationDispatcher } from './http-operation-dispatcher';

describe('HttpOperationDispatcher fifth-operation extensibility', () => {
  it('routes a fifth operation when only its adapter is registered', async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const pool = mockAgent.get('https://ai-writing.test');
    let interceptedPath: string | undefined;
    pool.intercept({ path: '/echo', method: 'POST' }).reply(200, { ok: true });
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    const fifthAdapter: DownstreamAdapter<unknown, unknown> = {
      operation: 'writing.echo.grade' as OperationId,
      downstream: 'ai-writing',
      buildRequest: (input, _context): DownstreamRequest => {
        interceptedPath = '/echo';
        return { method: 'POST', path: '/echo', body: input };
      },
      parseResponse: () => ({ echoed: true }),
    };
    const dispatcher = new HttpOperationDispatcher(
      httpClient,
      { mint: async () => 'token-abc' },
      [fifthAdapter],
      noOpDispatchAttemptRecord,
    );

    const result = await dispatcher.dispatch(
      'writing.echo.grade' as OperationId,
      // The fifth operation's id is not yet a member of the catalog's
      // operation union, so the union-wide input type must be satisfied by a
      // real member's shape; the adapter under test replaces the body anyway.
      {
        question: 'Describe the chart.',
        chart_type: 'Bar Chart',
        essay: 'A clear essay.',
        image_url: 'https://example.com/chart.png',
      },
      createRequestContext({
        requestId: 'req-fifth',
        receivedAt: new Date(),
        deadlineMs: 5_000,
        organizationId: 'org_test',
        scopes: [],
      }),
    );

    expect(interceptedPath).toBe('/echo');
    expect(result.operation).toBe('writing.echo.grade');
    expect(result.data).toEqual({ echoed: true });
    await mockAgent.close();
  });
});
