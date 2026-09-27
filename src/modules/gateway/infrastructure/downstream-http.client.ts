import { File } from 'node:buffer';

import { type Dispatcher, Pool, FormData as UndiciFormData } from 'undici';

import { AppError } from '../../../common/errors/app-error';
import type {
  DownstreamId,
  DownstreamMultipartBody,
  DownstreamRequest,
  InternalAIServiceResponse,
} from '../../../downstream/downstream.types';

export interface DownstreamHttpRequestOptions {
  readonly authorization?: string;
  readonly downstream?: DownstreamId;
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

type DownstreamBaseUrls =
  | string
  | Readonly<Partial<Record<DownstreamId, string>>>;
type DownstreamHeaders = Readonly<
  Partial<Record<DownstreamId, Readonly<Record<string, string>>>>
>;

const definitelyNotDispatched = new WeakSet<AppError>();

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
      cause: new Error(reason),
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

  constructor(
    private readonly baseUrls: DownstreamBaseUrls,
    private readonly sharedDispatcher?: Dispatcher,
    private readonly configuredHeaders: DownstreamHeaders = {},
  ) {}

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

    let response: Dispatcher.ResponseData;
    try {
      const requestOptions: Dispatcher.RequestOptions = {
        origin: base.origin,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: {
          ...this.configuredHeaders[downstream],
          ...(options.authorization === undefined
            ? {}
            : { authorization: options.authorization }),
          ...(isMultipartBody(request.body)
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
  }

  async close(): Promise<void> {
    if (this.sharedDispatcher !== undefined) {
      await this.sharedDispatcher.close();
      return;
    }

    await Promise.all(
      [...this.dispatchers.values()].map((dispatcher) => dispatcher.close()),
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

    const dispatcher = new Pool(base.origin, {
      connections: 10,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
    });
    this.dispatchers.set(base.origin, dispatcher);
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
      new File([Buffer.from(value.file.bytes)], value.file.filename, {
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
