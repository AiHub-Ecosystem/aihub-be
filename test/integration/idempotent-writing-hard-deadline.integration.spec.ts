import { Logger } from '@nestjs/common';
import { MockAgent } from 'undici';

import type {
  GradeResponse,
  GradeTask1Request,
} from '@/contracts/writing/grading';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { DownstreamRequest } from '@/downstream/downstream.types';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { createHttpOperationDispatcher } from '@/modules/gateway/infrastructure/http-operation-dispatcher.testing';
import type { IdempotencyRepositoryPort } from '@/modules/idempotency/application/idempotency-repository.port';
import { IdempotencyService } from '@/modules/idempotency/application/idempotency-service';
import type { DispatchAttemptRecordPort } from '@/modules/metering/public/dispatch-attempts';

describe('idempotent Writing hard deadline', () => {
  it('reaches the outbound request after caller disconnect and aborts at the hard deadline', async () => {
    const repository: IdempotencyRepositoryPort = {
      reserve: async ({ requestId }) => ({ kind: 'claimed', requestId }),
      complete: async () => undefined,
      markFailed: async () => undefined,
      delete: async () => undefined,
      cleanupExpired: async () => 0,
    };
    const service = new IdempotencyService(repository);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const httpClient = new DownstreamHttpClient(
      'https://ai-writing.test',
      mockAgent,
    );
    let deadlineHeader: number | undefined;
    mockAgent
      .get('https://ai-writing.test')
      .intercept({
        method: 'POST',
        path: '/task-one',
        headers: (headers) => {
          deadlineHeader = Number(headers['x-request-deadline']);
          return Number.isInteger(deadlineHeader) && deadlineHeader > 400;
        },
      })
      .reply(200, { ok: true })
      .delay(1_500);
    let timeoutMs: number | undefined;
    let requestSignal: AbortSignal | undefined;
    const send = httpClient.request.bind(httpClient);
    jest.spyOn(httpClient, 'request').mockImplementation((request, options) => {
      timeoutMs = options.deadlineMs;
      requestSignal = options.signal;
      return send(request, options);
    });
    const adapter: DownstreamAdapter<GradeTask1Request, GradeResponse> = {
      operation: 'writing.task1.grade',
      downstream: 'ai-writing',
      buildRequest: (): DownstreamRequest => ({
        method: 'POST',
        path: '/task-one',
        body: { essay: 'A clear essay.' },
      }),
      parseResponse: () => {
        throw new Error('the delayed response should be aborted');
      },
    };
    const attempts: DispatchAttemptRecordPort = {
      beginAttempt: async () => 'attempt-hard-deadline',
      recordOutcome: async () => undefined,
    };
    const dispatcher = createHttpOperationDispatcher(
      httpClient,
      {
        mint: async () => 'internal-token',
      } satisfies InternalTokenIssuerPort,
      [adapter],
      attempts,
    );
    const caller = new AbortController();
    const request = {
      organizationId: 'org_acme',
      operation: 'writing.task1.grade' as const,
      idempotencyKey: 'grade-1',
      actorId: 'user_1',
      requestBody: { essay: 'A clear essay.' },
      requestId: 'req_hard_deadline',
      timeoutMs: 400,
      signal: caller.signal,
      deadlineAt: new Date(Date.now() + 400),
    };
    const disconnectTimer = setTimeout(() => caller.abort(), 100);
    let downstreamWork: Promise<unknown> | undefined;

    try {
      await expect(
        service.execute(
          request,
          (work) => {
            const receivedAt = new Date();
            downstreamWork = dispatcher.dispatch(
              'writing.task1.grade',
              {
                question: 'Describe the chart.',
                chart_type: 'Bar Chart',
                essay: 'A clear essay.',
                image_url: 'https://example.com/chart.png',
              },
              {
                requestId: request.requestId,
                receivedAt,
                deadlineAt: work.deadlineAt,
                operationTimeoutMs: request.timeoutMs * 2,
                organizationId: request.organizationId,
                scopes: [],
                signal: work.signal,
              },
            );
            return downstreamWork;
          },
          () => {
            throw new Error('no replay expected');
          },
        ),
      ).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });

      if (
        timeoutMs === undefined ||
        deadlineHeader === undefined ||
        requestSignal === undefined ||
        downstreamWork === undefined
      ) {
        throw new Error('the Writing request did not reach the HTTP client');
      }
      expect(timeoutMs).toBeGreaterThan(request.timeoutMs);
      expect(deadlineHeader).toBe(timeoutMs);
      expect(caller.signal.aborted).toBe(true);
      expect(requestSignal.aborted).toBe(false);

      const signal = requestSignal;
      const work = downstreamWork;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      });
      await expect(work).rejects.toMatchObject({ code: 'AI_SERVICE_TIMEOUT' });
      expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
    } finally {
      clearTimeout(disconnectTimer);
      await mockAgent.close();
      loggerError.mockRestore();
    }
  });
});
