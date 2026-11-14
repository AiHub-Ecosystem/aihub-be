import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fetch as undiciFetch } from 'undici/index.js';

import { AppError } from '@/common/errors/app-error';
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
      page_size: query?.page_size,
      limit: query?.limit,
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
      page_size: query?.page_size,
      limit: query?.limit,
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
    const response = await this.executeFetch(url, headers);
    const data = Value.Clean(schema, await response.json());
    if (!Value.Check(schema, data)) {
      throw new AppError({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
        message: `Legacy backend returned invalid ${resource} payload`,
        retryable: false,
      });
    }
    return data;
  }

  private async executeFetch(
    url: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
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

      return response;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const isTimeout =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');

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
