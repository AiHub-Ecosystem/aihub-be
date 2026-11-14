import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fetch as undiciFetch } from 'undici/index.js';

import { AppError } from '@/common/errors/app-error';
import { isRecord } from '@/common/is-record';
import {
  type ListeningTestsResponse,
  ListeningTestsResponseSchema,
  type ReadingTestsResponse,
  ReadingTestsResponseSchema,
} from '@/contracts/practice/v2/tests';
import {
  type SpeakingLibraryResponse,
  SpeakingLibraryResponseSchema,
} from '@/contracts/speaking/v2/library';
import {
  type WritingTask1TemplatesResponse,
  WritingTask1TemplatesResponseSchema,
  type WritingTask2TemplatesResponse,
  WritingTask2TemplatesResponseSchema,
} from '@/contracts/writing/v2/templates';
import { encodeCursor } from '@/modules/content-proxy/application/cursor-pagination';
import type { FetchLegacyContentPort } from '@/modules/content-proxy/application/legacy-content.port';

const DEFAULT_TIMEOUT_MS = 10_000;

interface LegacyWritingItem {
  readonly id: number;
  readonly question: string;
  readonly typeId: number;
  readonly typeName: string;
  readonly sourceId: number;
  readonly sourceName: string;
  readonly imageAnalysisStatus: boolean;
  readonly image?: string;
  readonly title?: string;
  readonly questionType?: string;
  readonly subtype?: string;
  readonly sourceDetail?: string;
  readonly examDate?: string;
  readonly topic?: string;
  readonly difficulty?: string;
  readonly bookId?: number;
  readonly bookName?: string;
  readonly testId?: number;
  readonly testName?: string;
}

interface LegacySpeakingItem {
  readonly id: number;
  readonly originalId: number;
  readonly topic: string;
  readonly subtopic: string;
  readonly part: number;
  readonly difficulty: string;
  readonly permanentTopic: boolean;
  readonly source: string;
  readonly questions: string[];
  readonly createdAt: string;
  readonly imageUrl?: string;
  readonly forecast?: string;
  readonly topicType?: string;
  readonly cueCard?: string[];
}

interface LegacySpeakingResponse {
  readonly totalPages?: number;
  readonly items: readonly LegacySpeakingItem[];
}

interface LegacyPracticeTestItem {
  readonly id: number;
  readonly card_id: string;
  readonly test_id: number;
  readonly parts: number[];
  readonly title: string;
  readonly source: string;
  readonly total_questions: number;
  readonly estimated_minutes: number;
  readonly difficulty: string;
  readonly unit: string;
  readonly question_types: string[];
  readonly test_ref?: string;
  readonly section_number?: number;
  readonly topic?: string;
  readonly duration_seconds?: number;
  readonly thumbnail_url?: string;
  readonly audio_url?: string;
  readonly word_count?: number;
  readonly passage_id?: number;
}

interface LegacyPracticeTestsResponse {
  readonly total_pages?: number;
  readonly items: readonly LegacyPracticeTestItem[];
}

function mapBaseWritingTemplate(item: LegacyWritingItem) {
  return {
    id: item.id,
    question: item.question,
    type_id: item.typeId,
    type_name: item.typeName,
    source_id: item.sourceId,
    source_name: item.sourceName,
    image_analysis_status: Boolean(item.imageAnalysisStatus),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.questionType !== undefined
      ? { question_type: item.questionType }
      : {}),
    ...(item.subtype !== undefined ? { subtype: item.subtype } : {}),
    ...(item.sourceDetail !== undefined
      ? { source_detail: item.sourceDetail }
      : {}),
    ...(item.examDate !== undefined ? { exam_date: item.examDate } : {}),
    ...(item.topic !== undefined ? { topic: item.topic } : {}),
    ...(item.difficulty !== undefined ? { difficulty: item.difficulty } : {}),
    ...(item.bookId !== undefined ? { book_id: item.bookId } : {}),
    ...(item.bookName !== undefined ? { book_name: item.bookName } : {}),
    ...(item.testId !== undefined ? { test_id: item.testId } : {}),
    ...(item.testName !== undefined ? { test_name: item.testName } : {}),
  };
}

function mapBasePracticeTest(item: LegacyPracticeTestItem) {
  return {
    id: item.id,
    card_id: item.card_id,
    test_id: item.test_id,
    parts: item.parts,
    title: item.title,
    source: item.source,
    total_questions: item.total_questions,
    estimated_minutes: item.estimated_minutes,
    difficulty: item.difficulty,
    unit: item.unit,
    question_types: item.question_types,
  };
}

function paginateSlice<T>(
  items: readonly T[],
  limit: number,
  page: number,
): { readonly paged: readonly T[]; readonly nextCursor: string | null } {
  const startIndex = (page - 1) * limit;
  const paged = items.slice(startIndex, startIndex + limit);
  const nextCursor =
    startIndex + limit < items.length ? encodeCursor({ page: page + 1 }) : null;
  return { paged, nextCursor };
}

export class HttpLegacyContentClient implements FetchLegacyContentPort {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof undiciFetch;

  constructor(baseUrl: string, fetchFn: typeof undiciFetch = undiciFetch) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '');
    this.fetchFn = fetchFn;
  }

  async fetchWritingTask1Templates(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<WritingTask1TemplatesResponse> {
    const raw = await this.fetchJson<readonly LegacyWritingItem[]>(
      `${this.baseUrl}/api/WritingTemplate`,
      'WritingTemplate',
      { 'x-task-type': 'task 1' },
    );

    const mapped = raw.map((item) => ({
      task_type: 'Task 1' as const,
      image_url: item.image ?? '',
      ...mapBaseWritingTemplate(item),
    }));

    const { paged, nextCursor } = paginateSlice(mapped, limit, page);

    const response: WritingTask1TemplatesResponse = {
      data: {
        templates: [...paged],
        next_cursor: nextCursor,
      },
      meta: { request_id: requestId },
    };

    this.assertValid(
      WritingTask1TemplatesResponseSchema,
      response,
      'WritingTask1TemplatesResponse',
    );
    return response;
  }

  async fetchWritingTask2Templates(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<WritingTask2TemplatesResponse> {
    const raw = await this.fetchJson<readonly LegacyWritingItem[]>(
      `${this.baseUrl}/api/WritingTemplate`,
      'WritingTemplate',
      { 'x-task-type': 'task 2' },
    );

    const mapped = raw.map((item) => ({
      task_type: 'Task 2' as const,
      ...mapBaseWritingTemplate(item),
    }));

    const { paged, nextCursor } = paginateSlice(mapped, limit, page);

    const response: WritingTask2TemplatesResponse = {
      data: {
        templates: [...paged],
        next_cursor: nextCursor,
      },
      meta: { request_id: requestId },
    };

    this.assertValid(
      WritingTask2TemplatesResponseSchema,
      response,
      'WritingTask2TemplatesResponse',
    );
    return response;
  }

  async fetchSpeakingLibrary(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<SpeakingLibraryResponse> {
    const url = `${this.baseUrl}/api/Speaking/library?page=${page}&pageSize=${limit}`;
    const raw = await this.fetchJson<LegacySpeakingResponse>(
      url,
      'SpeakingLibrary',
    );

    const mapped = (raw.items ?? []).map((item) => ({
      id: item.id,
      original_id: item.originalId,
      topic: item.topic,
      subtopic: item.subtopic,
      part: item.part,
      difficulty: item.difficulty,
      permanent_topic: Boolean(item.permanentTopic),
      source: item.source,
      questions: item.questions,
      created_at: item.createdAt,
      ...(item.imageUrl !== undefined ? { image_url: item.imageUrl } : {}),
      ...(item.forecast !== undefined ? { forecast: item.forecast } : {}),
      ...(item.topicType !== undefined ? { topic_type: item.topicType } : {}),
      ...(item.cueCard !== undefined ? { cue_card: item.cueCard } : {}),
    }));

    const totalPages = raw.totalPages ?? 0;
    const nextCursor =
      page < totalPages ? encodeCursor({ page: page + 1 }) : null;

    const response: SpeakingLibraryResponse = {
      data: {
        topics: mapped,
        next_cursor: nextCursor,
      },
      meta: { request_id: requestId },
    };

    this.assertValid(
      SpeakingLibraryResponseSchema,
      response,
      'SpeakingLibraryResponse',
    );
    return response;
  }

  async fetchListeningTests(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<ListeningTestsResponse> {
    const url = `${this.baseUrl}/v1/listening/tests?page=${page}&pageSize=${limit}`;
    const raw = await this.fetchJson<LegacyPracticeTestsResponse>(
      url,
      'ListeningTests',
    );

    const mapped = (raw.items ?? []).map((item) => ({
      ...mapBasePracticeTest(item),
      ...(item.test_ref !== undefined ? { test_ref: item.test_ref } : {}),
      ...(item.section_number !== undefined
        ? { section_number: item.section_number }
        : {}),
      ...(item.topic !== undefined ? { topic: item.topic } : {}),
      ...(item.duration_seconds !== undefined
        ? { duration_seconds: item.duration_seconds }
        : {}),
      ...(item.thumbnail_url !== undefined
        ? { thumbnail_url: item.thumbnail_url }
        : {}),
      ...(item.audio_url !== undefined ? { audio_url: item.audio_url } : {}),
    }));

    const totalPages = raw.total_pages ?? 0;
    const nextCursor =
      page < totalPages ? encodeCursor({ page: page + 1 }) : null;

    const response: ListeningTestsResponse = {
      data: {
        tests: mapped,
        next_cursor: nextCursor,
      },
      meta: { request_id: requestId },
    };

    this.assertValid(
      ListeningTestsResponseSchema,
      response,
      'ListeningTestsResponse',
    );
    return response;
  }

  async fetchReadingTests(
    limit: number,
    page: number,
    requestId: string,
  ): Promise<ReadingTestsResponse> {
    const url = `${this.baseUrl}/v1/reading/tests?page=${page}&pageSize=${limit}`;
    const raw = await this.fetchJson<LegacyPracticeTestsResponse>(
      url,
      'ReadingTests',
    );

    const mapped = (raw.items ?? []).map((item) => ({
      ...mapBasePracticeTest(item),
      ...(item.word_count !== undefined ? { word_count: item.word_count } : {}),
      ...(item.thumbnail_url !== undefined
        ? { thumbnail_url: item.thumbnail_url }
        : {}),
      ...(item.passage_id !== undefined ? { passage_id: item.passage_id } : {}),
    }));

    const totalPages = raw.total_pages ?? 0;
    const nextCursor =
      page < totalPages ? encodeCursor({ page: page + 1 }) : null;

    const response: ReadingTestsResponse = {
      data: {
        tests: mapped,
        next_cursor: nextCursor,
      },
      meta: { request_id: requestId },
    };

    this.assertValid(
      ReadingTestsResponseSchema,
      response,
      'ReadingTestsResponse',
    );
    return response;
  }

  private assertValid(schema: TSchema, value: unknown, resource: string): void {
    if (!Value.Check(schema, value)) {
      throw new AppError({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
        message: `Constructed ${resource} violates contract schema`,
        retryable: false,
      });
    }
  }

  private async fetchJson<T>(
    url: string,
    resource: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const body = await this.fetchBody(url, headers);
    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new AppError({
        code: 'AI_SERVICE_CONTRACT_VIOLATION',
        message: `Legacy backend returned invalid ${resource} JSON`,
        retryable: false,
        cause: error,
      });
    }
  }

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
