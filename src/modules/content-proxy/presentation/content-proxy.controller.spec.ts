import type { FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import type { FetchLegacyContentPort } from '@/modules/content-proxy/application/legacy-content.port';
import { ContentProxyController } from './content-proxy.controller';

describe('ContentProxyController', () => {
  function createSubject() {
    const fetchWritingTemplates = jest.fn().mockResolvedValue([]);
    const fetchSpeakingLibrary = jest.fn().mockResolvedValue({
      totalCount: 0,
      page: 1,
      pageSize: 15,
      totalPages: 0,
      items: [],
    });
    const fetchListeningTests = jest.fn().mockResolvedValue({ items: [] });
    const fetchReadingTests = jest.fn().mockResolvedValue({ items: [] });

    const client: FetchLegacyContentPort = {
      fetchWritingTemplates,
      fetchSpeakingLibrary,
      fetchListeningTests,
      fetchReadingTests,
    };

    return {
      controller: new ContentProxyController(client),
      fetchWritingTemplates,
      fetchSpeakingLibrary,
      fetchListeningTests,
      fetchReadingTests,
    };
  }

  describe('getWritingTemplates', () => {
    it('passes the declared task type and ignores unrelated headers', async () => {
      const { controller, fetchWritingTemplates } = createSubject();
      const request = {
        headers: { 'x-task-type': 'task 2', accept: 'application/json' },
        query: {},
      } as unknown as FastifyRequest;

      await controller.getWritingTemplates(request);
      expect(fetchWritingTemplates.mock.calls).toEqual([['task 2']]);
    });

    it('rejects a task type outside the documented values', async () => {
      const { controller, fetchWritingTemplates } = createSubject();
      const request = {
        headers: { 'x-task-type': 'Task 2' },
        query: {},
      } as unknown as FastifyRequest;

      await expect(
        controller.getWritingTemplates(request),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetchWritingTemplates.mock.calls).toHaveLength(0);
    });

    it('rejects an undeclared query parameter', async () => {
      const { controller, fetchWritingTemplates } = createSubject();
      const request = {
        headers: { 'x-task-type': 'task 1' },
        query: { page: '2' },
      } as unknown as FastifyRequest;

      await expect(
        controller.getWritingTemplates(request),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetchWritingTemplates.mock.calls).toHaveLength(0);
    });

    it('rejects missing X-Task-Type header', async () => {
      const { controller } = createSubject();
      const request = {
        headers: {},
      } as unknown as FastifyRequest;

      await expect(controller.getWritingTemplates(request)).rejects.toThrow(
        AppError,
      );
    });

    it('rejects invalid X-Task-Type header', async () => {
      const { controller } = createSubject();
      const request = {
        headers: { 'x-task-type': 'task 3' },
      } as unknown as FastifyRequest;

      await expect(controller.getWritingTemplates(request)).rejects.toThrow(
        AppError,
      );
    });
  });

  describe('getSpeakingLibrary', () => {
    it('passes parsed query to client', async () => {
      const { controller, fetchSpeakingLibrary } = createSubject();
      const request = {
        query: { page: '2', pageSize: '10' },
      } as unknown as FastifyRequest;

      await controller.getSpeakingLibrary(request);
      expect(fetchSpeakingLibrary.mock.calls).toEqual([
        [{ page: '2', pageSize: '10' }],
      ]);
    });

    it('rejects invalid query parameter', async () => {
      const { controller } = createSubject();
      const request = {
        query: { unexpected_param: '123' },
      } as unknown as FastifyRequest;

      await expect(controller.getSpeakingLibrary(request)).rejects.toThrow(
        AppError,
      );
    });
  });

  describe('getListeningTests', () => {
    it('calls client with query', async () => {
      const { controller, fetchListeningTests } = createSubject();
      const request = {
        query: { page: '1' },
      } as unknown as FastifyRequest;

      await controller.getListeningTests(request);
      expect(fetchListeningTests.mock.calls).toEqual([[{ page: '1' }]]);
    });
  });

  describe('getReadingTests', () => {
    it('calls client with query', async () => {
      const { controller, fetchReadingTests } = createSubject();
      const request = {
        query: { pageSize: '5' },
      } as unknown as FastifyRequest;

      await controller.getReadingTests(request);
      expect(fetchReadingTests.mock.calls).toEqual([[{ pageSize: '5' }]]);
    });
  });
});
