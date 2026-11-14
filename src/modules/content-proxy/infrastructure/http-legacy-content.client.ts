import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fetch as undiciFetch } from 'undici/index.js';

import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  type ListeningTestsQuery,
  type ListeningTestsResponse,
  ListeningTestsResponseSchema,
} from '@/contracts/listening/tests';
import {
  type ReadingTestsQuery,
  type ReadingTestsResponse,
  ReadingTestsResponseSchema,
} from '@/contracts/reading/tests';
import {
  type SpeakingLibraryQuery,
  type SpeakingLibraryResponse,
  SpeakingLibraryResponseSchema,
} from '@/contracts/speaking/library';
import {
  type WritingTemplateListResponse,
  WritingTemplateListResponseSchema,
  type WritingTemplateTaskType,
} from '@/contracts/writing/template';
import type { FetchLegacyContentPort } from '@/modules/content-proxy/application/legacy-content.port';

const DEFAULT_TIMEOUT_MS = 10_000;

function buildQueryUrl(
  base: string,
  path: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, value);
  }
  const queryString = searchParams.toString();
  return `${base}${path}${queryString ? `?${queryString}` : ''}`;
}

// The legacy backend fails the way an AI Service does, so its faults reuse the
// existing AI_SERVICE_* codes rather than adding codes the Customer Web
// contract would first have to list (common rules).
export class HttpLegacyContentClient implements FetchLegacyContentPort {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof undiciFetch;

  constructor(baseUrl: string, fetchFn: typeof undiciFetch = undiciFetch) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '');
    this.fetchFn = fetchFn;
  }

  async fetchWritingTemplates(
    taskType: WritingTemplateTaskType,
  ): Promise<WritingTemplateListResponse> {
    return this.fetchAndValidate(
      `${this.baseUrl}/api/WritingTemplate`,
      WritingTemplateListResponseSchema,
      'WritingTemplate',
      { 'x-task-type': taskType },
    );
  }

  async fetchSpeakingLibrary(
    query?: SpeakingLibraryQuery,
  ): Promise<SpeakingLibraryResponse> {
    const url = buildQueryUrl(this.baseUrl, '/api/Speaking/library', {
      page: query?.page,
      pageSize: query?.pageSize,
    });
    return this.fetchAndValidate(
      url,
      SpeakingLibraryResponseSchema,
      'SpeakingLibrary',
    );
  }

  async fetchListeningTests(
    query?: ListeningTestsQuery,
  ): Promise<ListeningTestsResponse> {
    const url = buildQueryUrl(this.baseUrl, '/v1/listening/tests', {
      page: query?.page,
      pageSize: query?.pageSize,
    });
    return this.fetchAndValidate(
      url,
      ListeningTestsResponseSchema,
      'ListeningTests',
    );
  }

  async fetchReadingTests(
    query?: ReadingTestsQuery,
  ): Promise<ReadingTestsResponse> {
    const url = buildQueryUrl(this.baseUrl, '/v1/reading/tests', {
      page: query?.page,
      pageSize: query?.pageSize,
    });
    return this.fetchAndValidate(
      url,
      ReadingTestsResponseSchema,
      'ReadingTests',
    );
  }

  /**
   * Strips every field the public schema does not declare, then checks what
   * remains: the caller receives the mapped shape, never the raw legacy body.
   */
  private async fetchAndValidate<S extends TSchema>(
    url: string,
    schema: S,
    resource: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Static<S>> {
    const invalidPayload = (cause?: unknown): AppError =>
      new AppError({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
        message: `Legacy backend returned invalid ${resource} payload`,
        retryable: false,
        ...(cause === undefined ? {} : { cause }),
      });

    const body = await this.fetchBody(url, headers);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw invalidPayload(error);
    }
    const data = Value.Clean(schema, parsed);
    if (!Value.Check(schema, data)) {
      throw invalidPayload();
    }
    return data;
  }

  /**
   * Reads the whole body inside the transport boundary, so a stall, a cut
   * connection or the timeout while the body streams maps the same way as a
   * failure before the headers arrive.
   */
  private async fetchBody(
    url: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<string> {
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
        // An unread body holds its connection; release it before refusing.
        await response.body?.cancel().catch(() => undefined);
        throw new AppError({
          code:
            response.status >= 500
              ? 'AI_SERVICE_UNAVAILABLE'
              : 'AI_SERVICE_ERROR',
          message: `Legacy backend returned status ${response.status}`,
          retryable: response.status >= 500,
          downstreamStatus: response.status,
        });
      }

      return await response.text();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      // An abort is a DOMException, which may come from another realm than
      // this module's Error, so the name decides rather than `instanceof`.
      const isTimeout =
        isRecord(error) &&
        (error['name'] === 'TimeoutError' || error['name'] === 'AbortError');

      throw new AppError({
        code: isTimeout ? 'AI_SERVICE_TIMEOUT' : 'AI_SERVICE_UNAVAILABLE',
        message: isTimeout
          ? 'Legacy backend request timed out'
          : 'Legacy backend connection failed',
        retryable: true,
        cause: error,
      });
    }
  }
}
