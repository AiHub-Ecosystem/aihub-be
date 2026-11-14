import type { FastifyRequest } from 'fastify';

import { encodeCursor } from '@/modules/content-proxy/application/cursor-pagination';
import type { FetchLegacyContentPort } from '@/modules/content-proxy/application/legacy-content.port';
import { ContentProxyController } from './content-proxy.controller';

const REQ_ID = 'req_01J00000000000000000000000';

describe('ContentProxyController /v2', () => {
  function createSubject() {
    const fetchWritingTask1Templates = jest.fn().mockResolvedValue({
      data: { templates: [], next_cursor: null },
      meta: { request_id: REQ_ID },
    });
    const fetchWritingTask2Templates = jest.fn().mockResolvedValue({
      data: { templates: [], next_cursor: null },
      meta: { request_id: REQ_ID },
    });
    const fetchSpeakingLibrary = jest.fn().mockResolvedValue({
      data: { topics: [], next_cursor: null },
      meta: { request_id: REQ_ID },
    });
    const fetchListeningTests = jest.fn().mockResolvedValue({
      data: { tests: [], next_cursor: null },
      meta: { request_id: REQ_ID },
    });
    const fetchReadingTests = jest.fn().mockResolvedValue({
      data: { tests: [], next_cursor: null },
      meta: { request_id: REQ_ID },
    });

    const client: FetchLegacyContentPort = {
      fetchWritingTask1Templates,
      fetchWritingTask2Templates,
      fetchSpeakingLibrary,
      fetchListeningTests,
      fetchReadingTests,
    };

    return {
      controller: new ContentProxyController(client),
      fetchWritingTask1Templates,
      fetchWritingTask2Templates,
      fetchSpeakingLibrary,
      fetchListeningTests,
      fetchReadingTests,
    };
  }

  describe('getWritingTask1Templates', () => {
    it('uses default limit=20 and page=1 when query is empty', async () => {
      const { controller, fetchWritingTask1Templates } = createSubject();
      const request = {
        id: REQ_ID,
        query: {},
      } as unknown as FastifyRequest;

      await controller.getWritingTask1Templates(request);
      expect(fetchWritingTask1Templates.mock.calls).toEqual([[20, 1, REQ_ID]]);
    });

    it('decodes cursor and limit', async () => {
      const { controller, fetchWritingTask1Templates } = createSubject();
      const cursor = encodeCursor({ page: 3, limit: 50 });
      const request = {
        id: REQ_ID,
        query: { limit: '50', cursor },
      } as unknown as FastifyRequest;

      await controller.getWritingTask1Templates(request);
      expect(fetchWritingTask1Templates.mock.calls).toEqual([[50, 3, REQ_ID]]);
    });

    it('rejects cursor when reused with a different limit', async () => {
      const { controller, fetchWritingTask1Templates } = createSubject();
      const cursor = encodeCursor({ page: 2, limit: 20 });
      const request = {
        id: REQ_ID,
        query: { limit: '50', cursor },
      } as unknown as FastifyRequest;

      await expect(
        controller.getWritingTask1Templates(request),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetchWritingTask1Templates.mock.calls).toHaveLength(0);
    });

    it('rejects limit greater than 200', async () => {
      const { controller, fetchWritingTask1Templates } = createSubject();
      const request = {
        id: REQ_ID,
        query: { limit: '201' },
      } as unknown as FastifyRequest;

      await expect(
        controller.getWritingTask1Templates(request),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetchWritingTask1Templates.mock.calls).toHaveLength(0);
    });

    it('rejects malformed cursor', async () => {
      const { controller, fetchWritingTask1Templates } = createSubject();
      const request = {
        id: REQ_ID,
        query: { cursor: 'not-base64-json' },
      } as unknown as FastifyRequest;

      await expect(
        controller.getWritingTask1Templates(request),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetchWritingTask1Templates.mock.calls).toHaveLength(0);
    });

    it('rejects undeclared query parameters', async () => {
      const { controller, fetchWritingTask1Templates } = createSubject();
      const request = {
        id: REQ_ID,
        query: { undeclared: 'true' },
      } as unknown as FastifyRequest;

      await expect(
        controller.getWritingTask1Templates(request),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetchWritingTask1Templates.mock.calls).toHaveLength(0);
    });
  });

  describe('getWritingTask2Templates', () => {
    it('calls client with parsed pagination', async () => {
      const { controller, fetchWritingTask2Templates } = createSubject();
      const request = {
        id: REQ_ID,
        query: { limit: '10' },
      } as unknown as FastifyRequest;

      await controller.getWritingTask2Templates(request);
      expect(fetchWritingTask2Templates.mock.calls).toEqual([[10, 1, REQ_ID]]);
    });
  });

  describe('getSpeakingLibrary', () => {
    it('calls client with parsed pagination', async () => {
      const { controller, fetchSpeakingLibrary } = createSubject();
      const request = {
        id: REQ_ID,
        query: { limit: '15' },
      } as unknown as FastifyRequest;

      await controller.getSpeakingLibrary(request);
      expect(fetchSpeakingLibrary.mock.calls).toEqual([[15, 1, REQ_ID]]);
    });
  });

  describe('getListeningTests', () => {
    it('calls client with parsed pagination', async () => {
      const { controller, fetchListeningTests } = createSubject();
      const request = {
        id: REQ_ID,
        query: { limit: '30' },
      } as unknown as FastifyRequest;

      await controller.getListeningTests(request);
      expect(fetchListeningTests.mock.calls).toEqual([[30, 1, REQ_ID]]);
    });
  });

  describe('getReadingTests', () => {
    it('calls client with parsed pagination', async () => {
      const { controller, fetchReadingTests } = createSubject();
      const request = {
        id: REQ_ID,
        query: { limit: '25' },
      } as unknown as FastifyRequest;

      await controller.getReadingTests(request);
      expect(fetchReadingTests.mock.calls).toEqual([[25, 1, REQ_ID]]);
    });
  });
});
