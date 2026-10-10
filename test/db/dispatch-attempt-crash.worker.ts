import '../runtime-secret-env';

import Fastify from 'fastify';

import { setDispatchAttemptUnresolvedSource } from '@/common/observability/metrics';
import { registerMetricsRoute } from '@/common/observability/metrics.route';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type { GradeTask1Request } from '@/contracts/writing/grading';
import { task1GradeAdapter } from '@/downstream/writing/task1-grade.adapter';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/downstream-http.client';
import { HttpOperationDispatcher } from '@/modules/gateway/infrastructure/http-operation-dispatcher';
import { PostgresDispatchAttemptRepository } from '@/modules/metering/infrastructure/postgres-dispatch-attempt.repository';
import { createPostgresMeteringClient } from '@/modules/metering/infrastructure/postgres-usage.repository';

async function main(): Promise<void> {
  const repository = new PostgresDispatchAttemptRepository(
    createPostgresMeteringClient(process.env.DATABASE_URL ?? ''),
  );
  const downstream = new DownstreamHttpClient({
    'ai-writing': process.env.DOWNSTREAM_AI_WRITING_URL ?? '',
  });
  const tokenIssuer: InternalTokenIssuerPort = {
    mint: async () => 'dispatch-crash-test-token',
  };
  const dispatcher = new HttpOperationDispatcher(
    downstream,
    tokenIssuer,
    [task1GradeAdapter],
    repository,
  );
  const fastify = Fastify({ logger: false });
  fastify.post('/__test/dispatch-attempts/dispatch', async () => {
    const input: GradeTask1Request = {
      question: 'Crash durability test',
      chart_type: 'Bar Chart',
      essay: 'dispatch-attempt-crash-essay-marker',
      image_url: 'https://example.com/chart.png',
    };
    const timeoutMs = Number(process.env.DISPATCH_TEST_TIMEOUT_MS ?? '1000');
    const context = createRequestContext({
      requestId: process.env.DISPATCH_TEST_REQUEST_ID ?? 'req-crash-test',
      receivedAt: new Date(),
      deadlineMs: timeoutMs,
      organizationId:
        process.env.DISPATCH_TEST_ORGANIZATION_ID ?? 'org-crash-test',
      userId: 'dispatch-crash-test-user',
      scopes: [],
    });
    return dispatcher.dispatch('writing.task1.grade', input, context);
  });
  setDispatchAttemptUnresolvedSource(() =>
    repository.getUnresolvedByOperation(),
  );
  registerMetricsRoute(fastify);
  await fastify.ready();
  await fastify.listen({ port: 0, host: '127.0.0.1' });

  const address = fastify.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('dispatch test worker did not expose a port');
  }
  process.stdout.write(`AIHUB_TEST_READY:${address.port}\n`);

  process.once('SIGTERM', () => {
    setDispatchAttemptUnresolvedSource(undefined);
    void fastify
      .close()
      .then(() => Promise.all([downstream.close(), repository.close()]))
      .finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof Error
      ? `${error.name}: ${error.message}\n`
      : 'worker failed\n',
  );
  process.exit(1);
});
