import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError } from '@/common/errors/app-error';
import { registerRequestLifecycle } from '@/common/http/hooks/request-lifecycle.hook';
import { registerSpeakingJsonBodyCancellation } from './fastify-speaking-json-body.hook';

const JSON_PATH = OPERATION_CATALOG['speaking.grading-json'].path;
const OTHER_TIMED_PATH = OPERATION_CATALOG['writing.task1.grade'].path;

describe('registerSpeakingJsonBodyCancellation', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  function buildApp(): FastifyInstance {
    const instance = Fastify();
    registerRequestLifecycle(instance);
    registerSpeakingJsonBodyCancellation(instance);
    instance.route({
      method: 'POST',
      url: JSON_PATH,
      handler: async () => ({ ok: true }),
    });
    instance.route({
      method: 'POST',
      url: OTHER_TIMED_PATH,
      handler: async () => ({ ok: true }),
    });
    instance.setErrorHandler((error, _request, reply) => {
      const appError = error instanceof AppError ? error : undefined;
      reply
        .status(appError?.httpStatus ?? 500)
        .send({ code: appError?.code ?? 'INTERNAL_ERROR' });
    });
    return instance;
  }

  it('maps an expired deadline during JSON body parsing to the timeout contract', async () => {
    app = buildApp();
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: JSON_PATH,
        headers: { 'content-type': 'application/json' },
        payload: Readable.from(['{}']),
      });

      expect(response.statusCode).toBe(504);
      expect(response.json()).toEqual({ code: 'AI_SERVICE_TIMEOUT' });
    } finally {
      timeout.mockRestore();
    }
  });

  it('leaves another timed route body parse on the shared lifecycle', async () => {
    app = buildApp();
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: OTHER_TIMED_PATH,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(response.statusCode).toBe(200);
    } finally {
      timeout.mockRestore();
    }
  });
});
