import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { parseRequestQuery } from '@/common/http/parse-request-query';
import { PracticeContentPaginationQuerySchema } from '@/contracts/practice/v2/pagination-query';
import type {
  ListeningTestsResponse,
  ReadingTestsResponse,
} from '@/contracts/practice/v2/tests';
import type { SpeakingLibraryResponse } from '@/contracts/speaking/v2/library';
import type {
  WritingTask1TemplatesResponse,
  WritingTask2TemplatesResponse,
} from '@/contracts/writing/v2/templates';
import {
  decodeCursor,
  parseLimit,
} from '@/modules/content-proxy/application/cursor-pagination';
import {
  FETCH_LEGACY_CONTENT_PORT,
  type FetchLegacyContentPort,
} from '@/modules/content-proxy/application/legacy-content.port';

@Controller()
export class ContentProxyController {
  constructor(
    @Inject(FETCH_LEGACY_CONTENT_PORT)
    private readonly client: FetchLegacyContentPort,
  ) {}

  @Get('v2/ielts/writing/task1/templates')
  async getWritingTask1Templates(
    @Req() request: FastifyRequest,
  ): Promise<WritingTask1TemplatesResponse> {
    const query = parseRequestQuery(
      PracticeContentPaginationQuerySchema,
      request.query,
    );
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor, limit);
    return this.client.fetchWritingTask1Templates(
      limit,
      cursor.page,
      String(request.id),
    );
  }

  @Get('v2/ielts/writing/task2/templates')
  async getWritingTask2Templates(
    @Req() request: FastifyRequest,
  ): Promise<WritingTask2TemplatesResponse> {
    const query = parseRequestQuery(
      PracticeContentPaginationQuerySchema,
      request.query,
    );
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor, limit);
    return this.client.fetchWritingTask2Templates(
      limit,
      cursor.page,
      String(request.id),
    );
  }

  @Get('v2/ielts/speaking/library')
  async getSpeakingLibrary(
    @Req() request: FastifyRequest,
  ): Promise<SpeakingLibraryResponse> {
    const query = parseRequestQuery(
      PracticeContentPaginationQuerySchema,
      request.query,
    );
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor, limit);
    return this.client.fetchSpeakingLibrary(
      limit,
      cursor.page,
      String(request.id),
    );
  }

  @Get('v2/ielts/listening/tests')
  async getListeningTests(
    @Req() request: FastifyRequest,
  ): Promise<ListeningTestsResponse> {
    const query = parseRequestQuery(
      PracticeContentPaginationQuerySchema,
      request.query,
    );
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor, limit);
    return this.client.fetchListeningTests(
      limit,
      cursor.page,
      String(request.id),
    );
  }

  @Get('v2/ielts/reading/tests')
  async getReadingTests(
    @Req() request: FastifyRequest,
  ): Promise<ReadingTestsResponse> {
    const query = parseRequestQuery(
      PracticeContentPaginationQuerySchema,
      request.query,
    );
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor, limit);
    return this.client.fetchReadingTests(
      limit,
      cursor.page,
      String(request.id),
    );
  }
}
