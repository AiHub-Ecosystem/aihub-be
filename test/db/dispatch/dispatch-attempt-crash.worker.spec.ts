import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from '@/app.module';
import { registerMetricsRoute } from '@/common/observability/metrics.route';
import { generateRequestId } from '@/common/request-context/request-id';
import { registerRequestHooks } from '@/register-request-hooks';

describe('AIHUB crash worker', () => {
  it('runs the full Nest application until its parent kills the process', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ genReqId: () => generateRequestId() }),
    );
    app.enableShutdownHooks();
    const fastify = app.getHttpAdapter().getInstance();
    registerRequestHooks(fastify, undefined);
    registerMetricsRoute(fastify);
    await app.init();
    await fastify.ready();
    await app.listen(0, '127.0.0.1');

    const address = fastify.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('AIHUB test app did not expose a port');
    }
    expect(address.port).toBeGreaterThan(0);
    process.stdout.write(`AIHUB_TEST_READY:${address.port}\n`);

    await new Promise<void>(() => undefined);
  }, 60_000);
});
