import { File } from 'node:buffer';

import {
  type Dispatcher,
  Pool,
  FormData as UndiciFormData,
} from 'undici/index.js';

import { AppError, internalError } from '@/common/errors/app-error';
import { recordDownstreamLimitDropped } from '@/common/observability/downstream-concurrency-metrics';
import {
  type DownstreamPoolQueuedSample,
  setDownstreamPoolQueuedSource,
} from '@/common/observability/metrics';
import type {
  DownstreamId,
  DownstreamMultipartBody,
  DownstreamRequest,
  InternalAIServiceResponse,
} from '@/downstream/downstream.types';
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
  readonly onResponseReceived?: (statusCode: number) => void;
}

type DownstreamBaseUrls =
  | string
  | Readonly<Partial<Record<DownstreamId, string>>>;
type DownstreamHeaders = Readonly<
  Partial<Record<DownstreamId, Readonly<Record<string, string>>>>
>;

// The undici Pool cap stays a hard socket/stream ceiling; the per-origin
// Gradient2 limit is the adaptive admission signal that usually refuses
// excess work well before the Pool queues it (#1590, ADR-0154).
export const MAX_CONCURRENT_REQUESTS_PER_ORIGIN = 20;

const definitelyNotDispatched = new WeakSet<AppError>();
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

function markNotDispatched(error: AppError): AppError {
  definitelyNotDispatched.add(error);
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

  const timeout =
    signalAborted ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT';
  const mapped = timeout
    ? new AppError({
        code: 'AI_SERVICE_TIMEOUT',
        message: 'AI service request timed out',
        retryable: true,
        cause: error,
      })
    : new AppError({
        code: 'AI_SERVICE_UNAVAILABLE',
        message: 'AI service is temporarily unavailable',
        retryable: true,
        cause: error,
      });

  return !signalAborted &&
    [
      'UND_ERR_CONNECT_TIMEOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ].includes(code)
    ? markNotDispatched(mapped)
    : mapped;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
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
            ...this.configuredHeaders[downstream],
            ...request.headers,
            ...(options.authorization === undefined
              ? {}
              : { authorization: options.authorization }),
            ...(request.method === 'GET' || isMultipartBody(request.body)
              ? {}
              : { 'content-type': request.contentType ?? 'application/json' }),
            'x-request-id': options.requestId,
            'x-request-deadline': String(options.deadlineMs),
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

      let parsedBody: unknown;
      try {
        parsedBody = await response.body.json();
      } catch (error) {
        if (options.signal.aborted || isTransportFailure(error)) {
          throw transportError(error, options.signal.aborted);
        }
        if (response.statusCode >= 400) {
          parsedBody = undefined;
        } else {
          throw new AppError({
            code: 'AI_SERVICE_CONTRACT_VIOLATION',
            message: 'AI service returned an unexpected response shape',
            retryable: false,
            cause: error,
          });
        }
      }

      return {
        status: response.statusCode,
        headers: normalizeHeaders(response.headers),
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
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'multipart'
  );
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
