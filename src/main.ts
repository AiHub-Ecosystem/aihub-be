import './config/load-local-environment';
import { requestTracer } from './common/observability/open-telemetry';

import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { registerBodySizeGuard } from './common/http/body-size.hook';
import { registerRequestLifecycle } from './common/http/request-lifecycle.hook';
import { registerRequestTracing } from './common/http/request-tracing.hook';
import { createRequestLogging } from './common/observability/request-logger';
import { generateRequestId } from './common/request-context/request-id';
import {
  assertAuthBypassFlagIsSafe,
  assertHostConfigurationIsSafe,
} from './modules/identity/presentation/request-environment';
import { registerRequestCompletionLog } from './modules/metering/presentation/request-completion-log.hook';
import { registerSpeakingMultipartParser } from './modules/speaking/infrastructure/fastify-speaking-multipart.parser';

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024;

export async function bootstrap(): Promise<void> {
  assertAuthBypassFlagIsSafe();
  assertHostConfigurationIsSafe();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
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

  // Start the root span before other request hooks. Route templates keep paths
  // bounded and prevent raw request URLs or query values entering traces.
  if (requestTracer !== undefined) {
    registerRequestTracing(app.getHttpAdapter().getInstance(), requestTracer);
  }

  // Registered directly on the raw Fastify instance rather than through
  // Nest's own middleware/guard pipeline, so it runs before the body is parsed.
  registerBodySizeGuard(app.getHttpAdapter().getInstance());
  registerRequestLifecycle(app.getHttpAdapter().getInstance());

  // Registered after request tracing, which is what owns the span this line
  // names; the request id and the trace id then agree with the Metering record.
  registerRequestCompletionLog(app.getHttpAdapter().getInstance());

  // No global prefix: the operation catalog carries the full public path
  // (`/v1/ielts/writing/task1/grade`) so it stays the single source of truth and
  // matches the D1 contract verbatim. A prefix here would produce `/v1/v1/...`.
  // `/health` stays unversioned because probes are infrastructure, not API.
  await app.listen(Number(process.env.PORT ?? DEFAULT_PORT), '0.0.0.0');
}

void bootstrap();
