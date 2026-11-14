import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { parseRequestHeaders } from '@/common/http/parse-request-headers';
import { parseRequestQuery } from '@/common/http/parse-request-query';
import {
  ListeningTestsQuerySchema,
  type ListeningTestsResponse,
} from '@/contracts/listening/tests';
import {
  ReadingTestsQuerySchema,
  type ReadingTestsResponse,
} from '@/contracts/reading/tests';
import {
  SpeakingLibraryQuerySchema,
  type SpeakingLibraryResponse,
} from '@/contracts/speaking/library';
import {
  WritingTemplateHeadersSchema,
  type WritingTemplateListResponse,
  WritingTemplateQuerySchema,
} from '@/contracts/writing/template';
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

  @Get('api/WritingTemplate')
  async getWritingTemplates(
    @Req() request: FastifyRequest,
  ): Promise<WritingTemplateListResponse> {
    parseRequestQuery(WritingTemplateQuerySchema, request.query);
    const headers = parseRequestHeaders(
      WritingTemplateHeadersSchema,
      request.headers,
    );
    return this.client.fetchWritingTemplates(headers['x-task-type']);
  }

  @Get('api/Speaking/library')
  async getSpeakingLibrary(
    @Req() request: FastifyRequest,
  ): Promise<SpeakingLibraryResponse> {
    const query = parseRequestQuery(SpeakingLibraryQuerySchema, request.query);
    return this.client.fetchSpeakingLibrary(query);
  }

  @Get('v1/listening/tests')
  async getListeningTests(
    @Req() request: FastifyRequest,
  ): Promise<ListeningTestsResponse> {
    const query = parseRequestQuery(ListeningTestsQuerySchema, request.query);
    return this.client.fetchListeningTests(query);
  }

  @Get('v1/reading/tests')
  async getReadingTests(
    @Req() request: FastifyRequest,
  ): Promise<ReadingTestsResponse> {
    const query = parseRequestQuery(ReadingTestsQuerySchema, request.query);
    return this.client.fetchReadingTests(query);
  }
}
