import { Readable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';

import { OPERATION_CATALOG } from '../../catalog/operation-catalog';
import { AppError } from '../errors/app-error';
import {
  getRequestLifecycle,
  registerRequestLifecycle,
} from './request-lifecycle.hook';

const JSON_PATH = OPERATION_CATALOG['speaking.grading-json'].path;

describe('registerRequestLifecycle', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('starts the request deadline before JSON parsing and maps an expired body parse to 504', async () => {
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    app = Fastify();
    registerRequestLifecycle(app);
    app.route({
      method: 'POST',
      url: JSON_PATH,
      handler: async () => ({ ok: true }),
    });
    app.setErrorHandler((error, _request, reply) => {
      const appError = error instanceof AppError ? error : undefined;
      reply
        .status(appError?.httpStatus ?? 500)
        .send({ code: appError?.code ?? 'INTERNAL_ERROR' });
    });

    try {
      await app.ready();
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

  it('cleans the lifecycle state after a successful response', async () => {
    let rawRequest: object | undefined;
    app = Fastify();
    registerRequestLifecycle(app);
    app.route({
      method: 'POST',
      url: JSON_PATH,
      handler: async (request) => {
        rawRequest = request.raw;
        expect(getRequestLifecycle(rawRequest)).toBeDefined();
        return { ok: true };
      },
    });

    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: JSON_PATH,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(200);
    expect(rawRequest).toBeDefined();
    expect(getRequestLifecycle(rawRequest)).toBeUndefined();
  });

  // The reason a hook must take `done` is on the hook itself.
  it('leaves the response chain open for hooks registered after it', async () => {
    const seen: number[] = [];
    app = Fastify();
    registerRequestLifecycle(app);
    app.addHook('onResponse', (_request, _reply, done) => {
      seen.push(2);
      done();
    });
    app.route({
      method: 'POST',
      url: JSON_PATH,
      handler: async () => ({ ok: true }),
    });

    await app.ready();
    await app.inject({
      method: 'POST',
      url: JSON_PATH,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(seen).toEqual([2]);
  });
});
