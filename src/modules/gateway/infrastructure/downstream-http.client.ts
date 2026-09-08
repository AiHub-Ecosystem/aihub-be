import { type Dispatcher, Pool } from 'undici';

import { AppError } from '../../../common/errors/app-error';
import type {
  DownstreamRequest,
  InternalAIServiceResponse,
} from '../../../downstream/downstream.types';

export interface DownstreamHttpRequestOptions {
  readonly authorization: string;
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}

function configurationError(reason: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Downstream HTTP client is not configured',
    retryable: false,
    cause: new Error(reason),
  });
}

function transportError(error: unknown): AppError {
  const name = error instanceof Error ? error.name : '';
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';

  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return new AppError({
      code: 'AI_SERVICE_TIMEOUT',
      message: 'AI service request timed out',
      retryable: true,
      cause: error,
    });
  }

  return new AppError({
    code: 'AI_SERVICE_UNAVAILABLE',
    message: 'AI service is temporarily unavailable',
    retryable: true,
    cause: error,
  });
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
  private dispatcher: Dispatcher | undefined;

  constructor(
    private readonly baseUrl: string,
    dispatcher?: Dispatcher,
  ) {
    this.dispatcher = dispatcher;
  }

  async request(
    request: DownstreamRequest,
    options: DownstreamHttpRequestOptions,
  ): Promise<InternalAIServiceResponse<unknown>> {
    const base = this.parseBaseUrl();

    if (!request.path.startsWith('/') || request.path.startsWith('//')) {
      throw configurationError(
        'downstream paths must be relative to the configured origin',
      );
    }

    const url = new URL(request.path, base);
    if (url.origin !== base.origin) {
      throw configurationError('downstream path changed the configured origin');
    }

    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (body === undefined) {
        throw configurationError('downstream body is not JSON serializable');
      }
    }

    let response: Dispatcher.ResponseData;
    try {
      const requestOptions: Dispatcher.RequestOptions = {
        origin: base.origin,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: {
          authorization: options.authorization,
          'content-type': request.contentType ?? 'application/json',
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
      response = await this.getDispatcher().request(requestOptions);
    } catch (error) {
      throw transportError(error);
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.body.json();
    } catch (error) {
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
    if (this.dispatcher !== undefined) {
      await this.dispatcher.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private getDispatcher(): Dispatcher {
    if (this.dispatcher === undefined) {
      const base = this.parseBaseUrl();
      this.dispatcher = new Pool(base.origin, {
        connections: 10,
        keepAliveTimeout: 10_000,
        keepAliveMaxTimeout: 60_000,
      });
    }

    return this.dispatcher;
  }

  private parseBaseUrl(): URL {
    if (this.baseUrl.trim().length === 0) {
      throw configurationError('DOWNSTREAM_AI_WRITING_URL is missing');
    }

    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch (error) {
      throw configurationError('DOWNSTREAM_AI_WRITING_URL is invalid');
    }

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw configurationError('DOWNSTREAM_AI_WRITING_URL must be an origin');
    }

    return url;
  }
}
type ResponseHeaders = Record<string, string | string[] | undefined>;
