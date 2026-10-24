import './config/load-local-environment';
import './config/bootstrap-runtime-configuration';
import { GracefulFastifyAdapter } from './common/http/graceful-fastify-adapter';
import {
  requestTracer,
  shutdownOpenTelemetry,
} from './common/observability/open-telemetry';

import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createAppFastifyProxyOptions } from './app-fastify-proxy-options';
import { AppModule } from './app.module';
import { prepareSocketListener } from './common/http/unix-socket-listener';
import { registerMetricsRoute } from './common/observability/metrics.route';
import { createRequestLogging } from './common/observability/request-logger';
import { generateRequestId } from './common/request-context/request-id';
import { getRuntimeConfiguration } from './config/runtime-configuration';
import { registerSpeakingMultipartParser } from './modules/speaking/infrastructure/fastify-speaking-multipart.parser';
import { registerRequestHooks } from './register-request-hooks';

const MAX_BODY_BYTES = 1024 * 1024;

export async function bootstrap(): Promise<void> {
  const configuration = getRuntimeConfiguration();
  const listenSocket = configuration.AIHUB_LISTEN_SOCKET as string | undefined;

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new GracefulFastifyAdapter(
      {
        ...createAppFastifyProxyOptions(
          configuration.AIHUB_TRUSTED_PROXY_IP as string,
          listenSocket,
        ),
        // The structured request log, on Fastify's own Pino. One line per
        // response, built by the metering module's completion hook below.
        ...createRequestLogging(),
        // Outer ceiling only. Each operation carries its own `maxBodyBytes`.
        bodyLimit: MAX_BODY_BYTES,
        // Makes `request.id` the canonical AIHUB request id, so the exception
        // filter and every log line agree without extra middleware. Client-sent
        // ids are never trusted; correlation travels in `X-Correlation-Id`.
        genReqId: () => generateRequestId(),
      },
      shutdownOpenTelemetry,
    ),
  );

  app.enableShutdownHooks();

  const fastify = app.getHttpAdapter().getInstance();

  // Ingress timing must precede plugins that do request work in onRequest,
  // including cookie parsing. registerRequestHooks registers its timer first.
  registerRequestHooks(fastify, requestTracer);

  await Reflect.apply(fastify.register, fastify, [fastifyCookie]);

  registerSpeakingMultipartParser(fastify);

  // Registered after the hooks so the scrape itself is counted on response;
  // its increment appears in the following scrape, after this body is sent.
  registerMetricsRoute(fastify);

  // No global prefix: the operation catalog carries the full public path
  // (`/v1/ielts/writing/task1/grade`) so it stays the single source of truth and
  // matches the D1 contract verbatim. A prefix here would produce `/v1/v1/...`.
  // `/health` stays unversioned because probes are infrastructure, not API.
  //
  // With a socket, the reverse proxy uses it and the TCP listener stays on
  // loopback for in-container health checks: forwarded addresses are trusted
  // from any peer of either listener, so neither may be reachable by others.
  const openSocket =
    listenSocket === undefined
      ? undefined
      : prepareSocketListener(fastify, listenSocket);
  await app.listen(
    configuration.PORT,
    listenSocket === undefined ? '0.0.0.0' : '127.0.0.1',
  );
  await openSocket?.();
}

void bootstrap();
