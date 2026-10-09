import './config/load-local-environment';
import './config/bootstrap-runtime-configuration';
import { requestTracer } from './common/observability/open-telemetry';

import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { APP_FASTIFY_PROXY_OPTIONS } from './app-fastify-proxy-options';
import { AppModule } from './app.module';
import { registerMetricsRoute } from './common/observability/metrics.route';
import { createRequestLogging } from './common/observability/request-logger';
import { generateRequestId } from './common/request-context/request-id';
import { getRuntimeConfiguration } from './config/runtime-configuration';
import { registerSpeakingMultipartParser } from './modules/speaking/infrastructure/fastify-speaking-multipart.parser';
import { registerRequestHooks } from './register-request-hooks';

const MAX_BODY_BYTES = 1024 * 1024;

export async function bootstrap(): Promise<void> {
  const configuration = getRuntimeConfiguration();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      ...APP_FASTIFY_PROXY_OPTIONS,
      // The structured request log, on Fastify's own Pino. One line per
      // response, built by the metering module's completion hook below.
      ...createRequestLogging(),
      // Outer ceiling only. Each operation carries its own `maxBodyBytes`.
      bodyLimit: MAX_BODY_BYTES,
      // Makes `request.id` the canonical AIHUB request id, so the exception
      // filter and every log line agree without extra middleware. Client-sent
      // ids are never trusted; correlation travels in `X-Correlation-Id`.
      genReqId: () => generateRequestId(),
    }),
  );

  app.enableShutdownHooks();

  const fastify = app.getHttpAdapter().getInstance();
  await Reflect.apply(fastify.register, fastify, [fastifyCookie]);

  registerSpeakingMultipartParser(app.getHttpAdapter().getInstance());

  registerRequestHooks(app.getHttpAdapter().getInstance(), requestTracer);

  // Registered after the hooks so the scrape itself is observed by the same
  // completion path, and skipped by it: a scrape is not a customer request.
  registerMetricsRoute(app.getHttpAdapter().getInstance());

  // No global prefix: the operation catalog carries the full public path
  // (`/v1/ielts/writing/task1/grade`) so it stays the single source of truth and
  // matches the D1 contract verbatim. A prefix here would produce `/v1/v1/...`.
  // `/health` stays unversioned because probes are infrastructure, not API.
  await app.listen(configuration.PORT, '0.0.0.0');
}

void bootstrap();
