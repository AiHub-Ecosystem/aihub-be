import Fastify, { type FastifyInstance } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import {
  getRequestLifecycle,
  registerRequestLifecycle,
} from './request-lifecycle.hook';

const TIMED_PATH = OPERATION_CATALOG['writing.task1.grade'].path;

describe('registerRequestLifecycle', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('leaves body parsing to Fastify on a timed route without a body-cancellation owner', async () => {
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort());
    app = Fastify();
    registerRequestLifecycle(app);
    app.route({
      method: 'POST',
      url: TIMED_PATH,
      handler: async () => ({ ok: true }),
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: TIMED_PATH,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(response.statusCode).toBe(200);
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
      url: TIMED_PATH,
      handler: async (request) => {
        rawRequest = request.raw;
        expect(getRequestLifecycle(rawRequest)).toBeDefined();
        return { ok: true };
      },
    });

    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: TIMED_PATH,
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
      url: TIMED_PATH,
      handler: async () => ({ ok: true }),
    });

    await app.ready();
    await app.inject({
      method: 'POST',
      url: TIMED_PATH,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(seen).toEqual([2]);
  });
});
