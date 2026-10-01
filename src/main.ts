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
import { generateRequestId } from './common/request-context/request-id';
import {
  assertAuthBypassFlagIsSafe,
  assertHostConfigurationIsSafe,
} from './modules/identity/presentation/request-environment';
import { registerSpeakingMultipartParser } from './modules/speaking/infrastructure/fastify-speaking-multipart.parser';

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024;

export async function bootstrap(): Promise<void> {
  assertAuthBypassFlagIsSafe();
  assertHostConfigurationIsSafe();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
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

  // No global prefix: the operation catalog carries the full public path
  // (`/v1/ielts/writing/task1/grade`) so it stays the single source of truth and
  // matches the D1 contract verbatim. A prefix here would produce `/v1/v1/...`.
  // `/health` stays unversioned because probes are infrastructure, not API.
  await app.listen(Number(process.env.PORT ?? DEFAULT_PORT), '0.0.0.0');
}

void bootstrap();
