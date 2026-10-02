import { OPERATION_CATALOG } from '../../catalog/operation-catalog';
import { createErrorEnvelope } from '../errors/error-envelope';
import { isRequestId } from '../request-context/request-id';
import { recordRequestFailure } from './request-failure.recorder';
import { pathnameOf } from './request-path';

/**
 * Path -> per-operation body limit, built once from the catalog. All current
 * paths are static, so an exact match on the URL's pathname is enough; a
 * future parameterised path would need pattern matching here.
 */
const MAX_BODY_BYTES_BY_PATH: ReadonlyMap<string, number> = new Map(
  Object.values(OPERATION_CATALOG).map((operation) => [
    operation.path,
    operation.maxBodyBytes,
  ]),
);

interface OnRequestParams {
  readonly url: string;
  readonly id: unknown;
  readonly raw: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface OnRequestReply {
  code(statusCode: number): { send(payload: unknown): void };
}

interface OnRouteParams {
  readonly url?: string;
  readonly method?: string | readonly string[];
  bodyLimit?: number;
}

/**
 * Structural rather than the `fastify` package's own `FastifyInstance` type.
 * `@nestjs/platform-fastify` pins its own exact fastify version as a direct
 * dependency, separate from this project's own `fastify` range, so the two
 * resolve to different (structurally identical, nominally distinct) copies
 * in the dependency tree. A structural interface sidesteps that entirely:
 * whichever copy Nest hands back at the call site satisfies this shape.
 */
export interface HookableFastifyInstance {
  addHook(name: 'onRoute', handler: (route: OnRouteParams) => void): void;
  addHook(
    name: 'onRequest',
    handler: (
      request: OnRequestParams,
      reply: OnRequestReply,
      done: () => void,
    ) => void,
  ): void;
}

/**
 * Rejects an oversized body before Fastify buffers it into memory, using the
 * operation's own `maxBodyBytes` rather than the process-wide ceiling.
 *
 * Registered as a raw `onRequest` hook — the earliest stage in Fastify's
 * lifecycle, running before body parsing — rather than checked in a Nest
 * guard or controller, both of which only run after the full body has
 * already been read and parsed. A Nest-level check on the parsed object
 * (e.g. re-serialising it to measure size) is too late to protect memory and
 * measures the wrong thing besides: the re-serialised size is not the number
 * of bytes that came in over the wire.
 *
 * The matching route also receives Fastify's native per-route `bodyLimit`, so
 * chunked requests are capped while Fastify reads the stream rather than only
 * when a client declares an oversized `Content-Length`.
 */
export function registerBodySizeGuard(instance: HookableFastifyInstance): void {
  instance.addHook('onRoute', (route) => {
    const limit =
      route.url === undefined
        ? undefined
        : MAX_BODY_BYTES_BY_PATH.get(pathnameOf(route.url));
    const methods = Array.isArray(route.method) ? route.method : [route.method];

    if (limit !== undefined && methods.includes('POST')) {
      route.bodyLimit = limit;
    }
  });

  instance.addHook('onRequest', (request, reply, done) => {
    const limit = MAX_BODY_BYTES_BY_PATH.get(pathnameOf(request.url));

    if (limit === undefined) {
      done();
      return;
    }

    const header = request.headers['content-length'];
    const declaredBytes =
      typeof header === 'string' ? Number(header) : Number.NaN;

    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      const requestId = isRequestId(request.id) ? request.id : 'unknown';
      // This reply never reaches the exception filter, so the rejection records
      // its own public error code for the Request Completion Event.
      recordRequestFailure(request.raw, 'PAYLOAD_TOO_LARGE');
      reply.code(413).send(
        createErrorEnvelope({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body is too large',
          requestId,
          retryable: false,
        }),
      );
      return;
    }

    done();
  });
}
