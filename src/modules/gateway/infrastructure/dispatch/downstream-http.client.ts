import { File } from 'node:buffer';

import {
  type Dispatcher,
  Pool,
  FormData as UndiciFormData,
} from 'undici/index.js';

import {
  AppError,
  internalError,
  timeoutError,
} from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  type DownstreamPoolQueuedSample,
  setDownstreamPoolQueuedSource,
} from '@/common/observability/metrics/metrics';
import { contractViolation } from '@/downstream/contract-violation';
import type {
  DownstreamId,
  DownstreamMultipartBody,
  DownstreamRequest,
  InternalAIServiceResponse,
} from '@/downstream/downstream.types';
import {
  type DownstreamConcurrencySample,
  recordDownstreamLimitDropped,
} from './downstream-concurrency-metrics';
import {
  Gradient2ConcurrencyLimiter,
  type Gradient2Config,
} from './gradient2-concurrency-limiter';

export interface DownstreamHttpRequestOptions {
  readonly authorization?: string;
  readonly downstream?: DownstreamId;
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  /**
   * The most response body to read. The dispatcher passes the operation's own
   * limit; a caller that names none gets the default, so no read is unbounded.
   */
  readonly maxResponseBytes?: number;
  readonly onResponseReceived?: (statusCode: number) => void;
}

export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

type DownstreamBaseUrls =
  | string
  | Readonly<Partial<Record<DownstreamId, string>>>;
type DownstreamHeaders = Readonly<
  Partial<Record<DownstreamId, Readonly<Record<string, string>>>>
>;

// The undici Pool cap stays a hard socket/stream ceiling; the per-origin
// Gradient2 limit is the adaptive admission signal that usually refuses
// excess work well before the Pool queues it (#1590, ADR-0185).
export const MAX_CONCURRENT_REQUESTS_PER_ORIGIN = 20;

const definitelyNotDispatched = new WeakSet<AppError>();
const retryablePreSendConnectionFailures = new WeakSet<AppError>();
const downstreamPools = new Map<string, Set<Pool>>();

setDownstreamPoolQueuedSource(() => {
  const samples: DownstreamPoolQueuedSample[] = [];
  for (const [origin, pools] of downstreamPools) {
    let queued = 0;
    for (const pool of pools) {
      if (pool.destroyed) {
        pools.delete(pool);
        continue;
      }
      queued += pool.stats.queued;
    }
    if (pools.size === 0) {
      downstreamPools.delete(origin);
    } else {
      samples.push({ origin, queued });
    }
  }
  return samples;
});

export function isDefinitelyNotDispatched(error: unknown): boolean {
  return error instanceof AppError && definitelyNotDispatched.has(error);
}

export function isRetryablePreSendConnectionFailure(error: unknown): boolean {
  return (
    error instanceof AppError && retryablePreSendConnectionFailures.has(error)
  );
}

function markNotDispatched(error: AppError): AppError {
  definitelyNotDispatched.add(error);
  return error;
}

function markRetryablePreSendConnectionFailure(error: AppError): AppError {
  definitelyNotDispatched.add(error);
  retryablePreSendConnectionFailures.add(error);
  return error;
}

function configurationError(reason: string): AppError {
  return markNotDispatched(
    new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Downstream HTTP client is not configured',
      retryable: false,
      cause: internalError(reason),
    }),
  );
}

function transportError(error: unknown, signalAborted = false): AppError {
  const name = errorName(error);
  const code = errorCode(error);
  const preSendConnectionFailure =
    !signalAborted &&
    [
      'UND_ERR_CONNECT_TIMEOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ].includes(code);

  const timeout =
    signalAborted ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT';
  const mapped = preSendConnectionFailure
    ? new AppError({
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
        retryable: true,
        cause: error,
      })
    : timeout
      ? timeoutError(error)
      : new AppError({
          code: 'AI_SERVICE_UNAVAILABLE',
          message: 'AI service is temporarily unavailable',
          retryable: true,
          cause: error,
        });

  return preSendConnectionFailure
    ? markRetryablePreSendConnectionFailure(mapped)
    : mapped;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function errorCode(error: unknown): string {
  return isRecord(error) && 'code' in error ? String(error['code']) : '';
}

function isTransportFailure(error: unknown): boolean {
  const name = errorName(error);
  const code = errorCode(error);
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code.startsWith('UND_ERR_') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT'
  );
}

function normalizeHeaders(
  headers: ResponseHeaders,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    normalized[name.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : value;
  }

  return normalized;
}

/**
 * Reads a response body as JSON, counting the bytes as they arrive. Past the
 * limit the body is destroyed, which cancels the stream and frees its
 * connection, before an oversized value is allocated. The limit applies to the
 * bytes on the wire: the client does not ask for or decode a content encoding,
 * so those are also the bytes that become the JSON text (#377).
 */
async function readJsonWithin(
  body: AsyncIterable<unknown> & { destroy(): unknown },
  maxBytes: number,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of body) {
    const bytes =
      chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
    received += bytes.byteLength;
    if (received > maxBytes) {
      body.destroy();
      throw contractViolation(
        `response body exceeds the ${maxBytes} byte limit`,
      );
    }
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export class DownstreamHttpClient {
  private readonly dispatchers = new Map<string, Dispatcher>();
  private readonly inFlightByOrigin = new Map<string, number>();
  private readonly concurrencyLimiter: Gradient2ConcurrencyLimiter;

  constructor(
    private readonly baseUrls: DownstreamBaseUrls,
    private readonly sharedDispatcher?: Dispatcher,
    private readonly configuredHeaders: DownstreamHeaders = {},
    concurrencyConfig?: Gradient2Config,
  ) {
    this.concurrencyLimiter = new Gradient2ConcurrencyLimiter(
      concurrencyConfig,
    );
  }

  async request(
    request: DownstreamRequest,
    options: DownstreamHttpRequestOptions,
  ): Promise<InternalAIServiceResponse<unknown>> {
    const downstream = options.downstream ?? 'ai-writing';
    const base = this.parseBaseUrl(downstream);

    if (!request.path.startsWith('/') || request.path.startsWith('//')) {
      throw configurationError(
        'downstream paths must be relative to the configured origin',
      );
    }

    if (request.method === 'GET' && request.body !== undefined) {
      throw configurationError('downstream GET requests cannot have a body');
    }

    const url = new URL(request.path, base);
    if (url.origin !== base.origin) {
      throw configurationError('downstream path changed the configured origin');
    }

    let body: Dispatcher.RequestOptions['body'];
    if (request.body !== undefined) {
      body = toRequestBody(request.body);
      if (body === undefined) {
        throw configurationError('downstream body is not serializable');
      }
    }

    const startedAt = performance.now();
    const inFlight = this.inFlightByOrigin.get(base.origin) ?? 0;
    if (
      inFlight >= MAX_CONCURRENT_REQUESTS_PER_ORIGIN ||
      !this.concurrencyLimiter.tryAcquire(base.origin)
    ) {
      // Hard-ceiling refusals bypass tryAcquire(), so the drop counter the
      // acceptance criteria name would go silent exactly when a healthy
      // provider hits the default maximum of 20. Count the drop here too.
      if (inFlight >= MAX_CONCURRENT_REQUESTS_PER_ORIGIN) {
        recordDownstreamLimitDropped(base.origin);
      }
      throw markNotDispatched(
        new AppError({
          code: 'AI_SERVICE_UNAVAILABLE',
          message: 'AI service is temporarily unavailable',
          retryable: true,
          diagnostic: 'ai_service:bulkhead_exhausted',
        }),
      );
    }
    this.inFlightByOrigin.set(base.origin, inFlight + 1);

    try {
      let response: Dispatcher.ResponseData;
      try {
        const requestOptions: Dispatcher.RequestOptions = {
          origin: base.origin,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: {
            ...request.headers,
            ...(options.authorization === undefined
              ? {}
              : { authorization: options.authorization }),
            ...(request.method === 'GET' || isMultipartBody(request.body)
              ? {}
              : { 'content-type': request.contentType ?? 'application/json' }),
            'x-request-id': options.requestId,
            'x-request-deadline': String(options.deadlineMs),
            // Configured credentials are applied last: an adapter cannot
            // replace the per-service credential header AIHUB owns (#1866).
            ...this.configuredHeaders[downstream],
          },
          signal: options.signal,
          headersTimeout: options.deadlineMs,
          bodyTimeout: options.deadlineMs,
        };
        if (body !== undefined) {
          requestOptions.body = body;
        }
        response = await this.getDispatcher(base).request(requestOptions);
      } catch (error) {
        throw transportError(error, options.signal.aborted);
      }
      options.onResponseReceived?.(response.statusCode);

      const headers = normalizeHeaders(response.headers);
      const maxResponseBytes =
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      if (Number(headers['content-length']) > maxResponseBytes) {
        response.body.destroy();
        throw contractViolation(
          `response body exceeds the ${maxResponseBytes} byte limit`,
        );
      }

      let parsedBody: unknown;
      try {
        parsedBody = await readJsonWithin(response.body, maxResponseBytes);
      } catch (error) {
        // An oversized body is a contract violation on any status.
        if (error instanceof AppError) throw error;
        if (options.signal.aborted || isTransportFailure(error)) {
          throw transportError(error, options.signal.aborted);
        }
        if (response.statusCode >= 400) {
          parsedBody = undefined;
        } else {
          throw contractViolation(undefined, error);
        }
      }

      return {
        status: response.statusCode,
        headers,
        body: parsedBody,
      };
    } finally {
      this.concurrencyLimiter.release(
        base.origin,
        Math.max(0, performance.now() - startedAt),
      );
      const remaining = (this.inFlightByOrigin.get(base.origin) ?? 1) - 1;
      if (remaining === 0) {
        this.inFlightByOrigin.delete(base.origin);
      } else {
        this.inFlightByOrigin.set(base.origin, remaining);
      }
    }
  }

  /**
   * The live adaptive capacity per origin. Read by the shedding governor: the
   * limiter's own `inFlight / limit` is the overload signal (ADR-0173), so
   * there is no second limiter to disagree with it.
   */
  concurrencySnapshot(): readonly DownstreamConcurrencySample[] {
    return this.concurrencyLimiter.snapshot();
  }

  async close(): Promise<void> {
    if (this.sharedDispatcher !== undefined) {
      await this.sharedDispatcher.close();
      return;
    }

    await Promise.all(
      [...this.dispatchers.entries()].map(async ([origin, dispatcher]) => {
        await dispatcher.close();
        if (dispatcher instanceof Pool) {
          const pools = downstreamPools.get(origin);
          pools?.delete(dispatcher);
          if (pools?.size === 0) downstreamPools.delete(origin);
        }
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private getDispatcher(base: URL): Dispatcher {
    if (this.sharedDispatcher !== undefined) {
      return this.sharedDispatcher;
    }

    const existing = this.dispatchers.get(base.origin);
    if (existing !== undefined) {
      return existing;
    }

    // This limit preserves HTTP/1.1 capacity and caps multiplexed HTTP/2 streams.
    //
    // `keepAliveTimeout` was 10s, which expires a socket inside the bursts
    // this gateway sees: production traffic runs around one request a minute
    // for an hour and then stops for hours, so the next request of a burst
    // was paying a fresh TCP and TLS handshake. `keepAliveMaxTimeout` stays
    // below the ceiling a provider can ask for.
    const dispatcher = new Pool(base.origin, {
      allowH2: true,
      connections: MAX_CONCURRENT_REQUESTS_PER_ORIGIN,
      keepAliveTimeout: 300_000,
      keepAliveMaxTimeout: 600_000,
    });
    this.dispatchers.set(base.origin, dispatcher);
    const pools = downstreamPools.get(base.origin) ?? new Set<Pool>();
    pools.add(dispatcher);
    downstreamPools.set(base.origin, pools);
    return dispatcher;
  }

  private parseBaseUrl(downstream: DownstreamId): URL {
    const baseUrl =
      typeof this.baseUrls === 'string'
        ? this.baseUrls
        : (this.baseUrls[downstream] ?? '');

    if (baseUrl.trim().length === 0) {
      throw configurationError(`URL for ${downstream} is missing`);
    }

    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw configurationError(`URL for ${downstream} is invalid`);
    }

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw configurationError(`URL for ${downstream} must be an origin`);
    }

    return url;
  }
}

function isMultipartBody(value: unknown): value is DownstreamMultipartBody {
  return isRecord(value) && 'kind' in value && value['kind'] === 'multipart';
}

function toRequestBody(
  value: unknown,
): Dispatcher.RequestOptions['body'] | undefined {
  if (isMultipartBody(value)) {
    const form = new UndiciFormData();
    form.set(
      value.file.fieldName,
      // A File built from a Blob references its data; it does not copy it.
      new File([value.file.blob], value.file.filename, {
        type: value.file.contentType,
      }),
      value.file.filename,
    );
    for (const [name, fieldValue] of Object.entries(value.fields)) {
      form.set(name, fieldValue);
    }
    return form;
  }

  return JSON.stringify(value);
}
type ResponseHeaders = Record<string, string | string[] | undefined>;
